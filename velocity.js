(function() {
    'use strict';

    // Enhanced configuration system
    const DEFAULT_CONFIG = {
        MAX_CACHED_LINKS: 100,
        DB_NAME: 'VelocityDB',
        DB_VERSION: 2,
        STORE_NAME: 'preloadedContent',
        ANALYTICS_STORE: 'usageAnalytics',
        SW_PATH: '/velocity-worker.js',
        PREFETCH_TIMEOUT: 3000,
        CLEANUP_INTERVAL: 300000, // 5 minutes
        MAX_CONCURRENT_PREFETCH: 3,
        VISUAL_FEEDBACK: false,
        DEBUG_MODE: false,
        CACHE_VERSION: '1.0.0',
        PRIORITY_WEIGHTS: {
            click: 10,
            hover: 5,
            touch: 7,
            visible: 3
        }
    };

    // Load DOMPurify if available, otherwise use fallback
    const loadDOMPurify = async () => {
        try {
            if (typeof DOMPurify !== 'undefined') {
                return DOMPurify;
            }
            // Try to load from CDN as fallback
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js';
            document.head.appendChild(script);
            
            return new Promise((resolve) => {
                script.onload = () => resolve(window.DOMPurify);
                script.onerror = () => resolve(null);
            });
        } catch {
            return null;
        }
    };

    class Velocity {
        constructor(userConfig = {}) {
            this.config = { ...DEFAULT_CONFIG, ...userConfig };
            this.db = null;
            this.domPurify = null;
            this.prefetchQueue = new Map();
            this.prefetchedUrls = new Map(); // Store with metadata
            this.prerenderedUrls = new Set();
            this.isServiceWorkerReady = false;
            this.broadcastChannel = null;
            this.performanceObserver = null;
            this.cleanupWorker = null;
            this.prefetchSemaphore = 0;
            this.urlAnalytics = new Map();
            this.intersectionObserver = null;
            
            this.init();
        }

        async init() {
            try {
                this.log('Initializing Velocity...');
                
                // Initialize components in parallel where possible
                await Promise.all([
                    this.initDOMPurify(),
                    this.initIndexedDB(),
                    this.initBroadcastChannel(),
                    this.registerServiceWorker()
                ]);
                
                this.initPerformanceObserver();
                this.initIntersectionObserver();
                this.attachEventListeners();
                this.startCleanupScheduler();
                this.showVisualFeedback('Velocity.js initialized');
                
                this.log('Velocity initialized successfully');
            } catch (error) {
                this.logError('Velocity initialization failed:', error);
            }
        }

        // Enhanced logging
        log(message, ...args) {
            if (this.config.DEBUG_MODE) {
                console.log(`[Velocity] ${message}`, ...args);
            }
        }

        logError(message, error) {
            console.error(`[Velocity] ${message}`, error);
        }

        // Initialize DOMPurify for robust sanitization
        async initDOMPurify() {
            this.domPurify = await loadDOMPurify();
            if (!this.domPurify) {
                this.log('DOMPurify not available, using fallback sanitization');
            }
        }

        // Enhanced IndexedDB with analytics store
        async initIndexedDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.config.DB_NAME, this.config.DB_VERSION);
                
                request.onerror = () => {
                    this.logError('IndexedDB initialization failed:', request.error);
                    reject(request.error);
                };
                
                request.onsuccess = () => {
                    this.db = request.result;
                    this.db.onerror = (event) => {
                        this.logError('IndexedDB error:', event.target.error);
                    };
                    resolve();
                };
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    
                    // Main cache store
                    if (!db.objectStoreNames.contains(this.config.STORE_NAME)) {
                        const store = db.createObjectStore(this.config.STORE_NAME, { keyPath: 'url' });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                        store.createIndex('priority', 'priority', { unique: false });
                        store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
                        store.createIndex('accessCount', 'accessCount', { unique: false });
                    }
                    
                    // Analytics store
                    if (!db.objectStoreNames.contains(this.config.ANALYTICS_STORE)) {
                        const analyticsStore = db.createObjectStore(this.config.ANALYTICS_STORE, { keyPath: 'url' });
                        analyticsStore.createIndex('visitCount', 'visitCount', { unique: false });
                        analyticsStore.createIndex('avgLoadTime', 'avgLoadTime', { unique: false });
                    }
                };
            });
        }

        // BroadcastChannel for efficient SW communication
        initBroadcastChannel() {
            try {
                if ('BroadcastChannel' in window) {
                    this.broadcastChannel = new BroadcastChannel('velocity-cache-channel');
                    this.broadcastChannel.onmessage = this.handleBroadcastMessage.bind(this);
                    this.log('BroadcastChannel initialized');
                } else {
                    this.log('BroadcastChannel not supported, falling back to postMessage');
                }
            } catch (error) {
                this.logError('BroadcastChannel initialization failed:', error);
            }
        }

        // Enhanced service worker registration
        async registerServiceWorker() {
            if (!('serviceWorker' in navigator)) {
                this.log('Service Worker not supported');
                return;
            }

            try {
                const registration = await navigator.serviceWorker.register(this.config.SW_PATH, {
                    scope: '/',
                    updateViaCache: 'imports'
                });

                // Handle updates
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            this.showVisualFeedback('New version available, refreshing...');
                            window.location.reload();
                        }
                    });
                });

                // Wait for SW to be ready
                await navigator.serviceWorker.ready;
                this.isServiceWorkerReady = true;
                
                this.log('Service Worker registered and ready');
            } catch (error) {
                this.logError('Service Worker registration failed:', error);
            }
        }

        // Performance observer for resource timing
        initPerformanceObserver() {
            if ('PerformanceObserver' in window) {
                try {
                    this.performanceObserver = new PerformanceObserver((list) => {
                        list.getEntries().forEach(this.handlePerformanceEntry.bind(this));
                    });
                    
                    this.performanceObserver.observe({ 
                        entryTypes: ['navigation', 'resource', 'measure'] 
                    });
                    
                    this.log('PerformanceObserver initialized');
                } catch (error) {
                    this.logError('PerformanceObserver initialization failed:', error);
                }
            }
        }

        // Intersection observer for visible links
        initIntersectionObserver() {
            if ('IntersectionObserver' in window) {
                this.intersectionObserver = new IntersectionObserver(
                    this.handleIntersection.bind(this),
                    { threshold: 0.1, rootMargin: '50px' }
                );
                this.log('IntersectionObserver initialized');
            }
        }

        // Enhanced event listeners with passive options
        attachEventListeners() {
            const passiveOptions = { passive: true, capture: true };
            
            document.addEventListener('touchstart', this.handleTouchStart.bind(this), passiveOptions);
            document.addEventListener('mouseover', this.handleMouseOver.bind(this), passiveOptions);
            document.addEventListener('click', this.handleClick.bind(this), passiveOptions);
            document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
            
            // Observe all links for visibility
            this.observeLinks();
            
            // Re-observe when DOM changes
            if ('MutationObserver' in window) {
                const mutationObserver = new MutationObserver(() => {
                    this.observeLinks();
                });
                mutationObserver.observe(document.body, { 
                    childList: true, 
                    subtree: true 
                });
            }
        }

        // Observe links for intersection
        observeLinks() {
            if (!this.intersectionObserver) return;
            
            document.querySelectorAll('a[href]').forEach(link => {
                if (!link.dataset.velocityCacheObserved) {
                    this.intersectionObserver.observe(link);
                    link.dataset.velocityCacheObserved = 'true';
                }
            });
        }

        // Handle intersection events
        handleIntersection(entries) {
            entries.forEach(entry => {
                if (entry.isIntersecting && entry.target.href) {
                    this.processLink(entry.target.href, 'visible', 1);
                }
            });
        }

        // Enhanced event handlers with priority calculation
        handleTouchStart(event) {
            const link = this.findLinkElement(event.target);
            if (link) {
                const priority = this.calculatePriority(link, 'touch');
                this.processLink(link.href, 'touch', priority);
            }
        }

        handleMouseOver(event) {
            const link = this.findLinkElement(event.target);
            if (link) {
                const priority = this.calculatePriority(link, 'hover');
                this.processLink(link.href, 'hover', priority);
            }
        }

        handleClick(event) {
            const link = this.findLinkElement(event.target);
            if (link) {
                const priority = this.calculatePriority(link, 'click');
                this.processLink(link.href, 'click', priority);
                this.updateAnalytics(link.href);
            }
        }

        handleVisibilityChange() {
            if (document.hidden) {
                // Pause prefetching when tab is hidden
                this.pausePrefetching();
            } else {
                // Resume prefetching when tab becomes visible
                this.resumePrefetching();
            }
        }

        // Smart priority calculation
        calculatePriority(linkElement, trigger) {
            let priority = this.config.PRIORITY_WEIGHTS[trigger] || 1;
            
            // Boost priority based on element properties
            if (linkElement.classList.contains('priority-high')) priority *= 2;
            if (linkElement.closest('nav')) priority *= 1.5;
            if (linkElement.closest('.main-content')) priority *= 1.3;
            
            // Boost based on analytics
            const analytics = this.urlAnalytics.get(linkElement.href);
            if (analytics) {
                priority *= (1 + analytics.visitCount * 0.1);
            }
            
            return Math.round(priority);
        }

        // Enhanced link processing with queue management
        async processLink(url, trigger, priority = 1) {
            if (!this.isValidUrl(url)) return;

            const sanitizedUrl = this.sanitizeUrl(url);
            const existing = this.prefetchedUrls.get(sanitizedUrl);
            
            if (existing && existing.priority >= priority) {
                return; // Already processed with higher or equal priority
            }

            try {
                // Add to queue with priority
                this.prefetchQueue.set(sanitizedUrl, {
                    url: sanitizedUrl,
                    trigger,
                    priority,
                    timestamp: Date.now()
                });

                // Process queue
                await this.processQueue();
                
                this.log(`Queued ${sanitizedUrl} via ${trigger} (priority: ${priority})`);
            } catch (error) {
                this.logError(`Failed to process ${url}:`, error);
            }
        }

        // Smart queue processing with concurrency control
        async processQueue() {
            if (this.prefetchSemaphore >= this.config.MAX_CONCURRENT_PREFETCH) {
                return; // Too many concurrent requests
            }

            // Sort queue by priority
            const sortedQueue = Array.from(this.prefetchQueue.entries())
                .sort(([,a], [,b]) => b.priority - a.priority);

            for (const [url, item] of sortedQueue.slice(0, this.config.MAX_CONCURRENT_PREFETCH)) {
                if (this.prefetchSemaphore >= this.config.MAX_CONCURRENT_PREFETCH) break;
                
                this.prefetchSemaphore++;
                this.prefetchQueue.delete(url);
                
                this.prefetchResource(item)
                    .finally(() => {
                        this.prefetchSemaphore--;
                    });
            }
        }

        // Enhanced prefetching with better error handling
        async prefetchResource(item) {
            const { url, trigger, priority } = item;
            
            try {
                // Check if already prefetched recently
                const existing = this.prefetchedUrls.get(url);
                if (existing && (Date.now() - existing.timestamp) < 60000) {
                    return;
                }

                const startTime = performance.now();

                // Parallel prefetch strategies
                const promises = [];

                // Native browser prefetch
                promises.push(this.nativePrefetch(url));

                // Service Worker prefetch via BroadcastChannel
                if (this.broadcastChannel && this.isServiceWorkerReady) {
                    promises.push(this.serviceWorkerPrefetch(url, priority));
                }

                await Promise.allSettled(promises);

                // Store metadata
                this.prefetchedUrls.set(url, {
                    timestamp: Date.now(),
                    trigger,
                    priority,
                    loadTime: performance.now() - startTime
                });

                // Store in IndexedDB
                await this.storeInCache(url, trigger, priority);

                // Prerender high-priority resources
                if (priority >= 8) {
                    this.prerenderPage(url);
                }

                this.showVisualFeedback(`Prefetched: ${url}`);
                
            } catch (error) {
                this.logError(`Prefetch failed for ${url}:`, error);
            }
        }

        // Native browser prefetch
        async nativePrefetch(url) {
            return new Promise((resolve, reject) => {
                const link = document.createElement('link');
                link.rel = 'prefetch';
                link.href = url;
                link.as = 'document';
                link.crossOrigin = 'anonymous';
                
                link.onload = () => {
                    resolve();
                    // Remove after successful load
                    setTimeout(() => link.remove(), 1000);
                };
                
                link.onerror = () => {
                    reject(new Error(`Native prefetch failed for ${url}`));
                    link.remove();
                };
                
                document.head.appendChild(link);
                
                // Timeout
                setTimeout(() => {
                    reject(new Error('Prefetch timeout'));
                    link.remove();
                }, this.config.PREFETCH_TIMEOUT);
            });
        }

        // Service worker prefetch via BroadcastChannel
        async serviceWorkerPrefetch(url, priority) {
            if (!this.broadcastChannel) {
                throw new Error('BroadcastChannel not available');
            }

            return new Promise((resolve, reject) => {
                const messageId = `prefetch_${Date.now()}_${Math.random()}`;
                
                const timeout = setTimeout(() => {
                    reject(new Error('SW prefetch timeout'));
                }, this.config.PREFETCH_TIMEOUT);

                const handleResponse = (event) => {
                    if (event.data.messageId === messageId) {
                        clearTimeout(timeout);
                        this.broadcastChannel.removeEventListener('message', handleResponse);
                        
                        if (event.data.success) {
                            resolve();
                        } else {
                            reject(new Error(event.data.error || 'SW prefetch failed'));
                        }
                    }
                };

                this.broadcastChannel.addEventListener('message', handleResponse);
                
                this.broadcastChannel.postMessage({
                    type: 'PREFETCH',
                    url,
                    priority,
                    messageId
                });
            });
        }

        // Enhanced HTML sanitization
        sanitizeHtml(html) {
            if (this.domPurify) {
                return this.domPurify.sanitize(html, {
                    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
                    ALLOWED_ATTR: ['class', 'id'],
                    KEEP_CONTENT: true,
                    RETURN_DOM: false
                });
            }
            
            // Fallback sanitization
            const temp = document.createElement('div');
            temp.textContent = html;
            let sanitized = temp.innerHTML;
            
            // Enhanced XSS prevention
            sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
            sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
            sanitized = sanitized.replace(/javascript:/gi, '');
            sanitized = sanitized.replace(/data:/gi, '');
            sanitized = sanitized.replace(/vbscript:/gi, '');
            
            return sanitized;
        }

// Enhanced cache storage with LRU eviction - FIXED VERSION
async storeInCache(url, trigger, priority) {
    if (!this.db) return;

    try {
        const content = await this.fetchAndSanitizeContent(url);
        
        const cacheEntry = {
            url,
            timestamp: Date.now(),
            lastAccessed: Date.now(),
            accessCount: 1,
            trigger,
            priority,
            content,
            version: this.config.CACHE_VERSION
        };

        // Create a single transaction for the entire operation
        const transaction = this.db.transaction([this.config.STORE_NAME], 'readwrite');
        const store = transaction.objectStore(this.config.STORE_NAME);
        
        // First, try to get existing entry
        const existingRequest = store.get(url);
        
        await new Promise((resolve, reject) => {
            existingRequest.onsuccess = () => {
                if (existingRequest.result) {
                    cacheEntry.accessCount = existingRequest.result.accessCount + 1;
                }
                
                // Put the updated entry in the same transaction
                const putRequest = store.put(cacheEntry);
                putRequest.onsuccess = () => resolve();
                putRequest.onerror = () => reject(putRequest.error);
            };
            
            existingRequest.onerror = () => {
                // If get fails, just put the new entry
                const putRequest = store.put(cacheEntry);
                putRequest.onsuccess = () => resolve();
                putRequest.onerror = () => reject(putRequest.error);
            };
        });

        await this.cleanupOldEntries();
    } catch (error) {
        this.logError('Failed to store in cache:', error);
    }
}

        // LRU-based cleanup with background processing
        async cleanupOldEntries() {
            if (!this.db) return;

            // Use Web Worker for cleanup if available
            if (this.cleanupWorker) {
                this.cleanupWorker.postMessage({
                    type: 'CLEANUP',
                    dbName: this.config.DB_NAME,
                    storeName: this.config.STORE_NAME,
                    maxEntries: this.config.MAX_CACHED_LINKS
                });
                return;
            }

            // Fallback to main thread cleanup
            try {
                const transaction = this.db.transaction([this.config.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(DEFAULT_CONFIG.STORE_NAME);
                
                const countRequest = store.count();
                const count = await new Promise((resolve) => {
                    countRequest.onsuccess = () => resolve(countRequest.result);
                });

                if (count > this.config.MAX_CACHED_LINKS) {
                    // Get entries sorted by LRU (least recently accessed + lowest access count)
                    const entries = await new Promise((resolve) => {
                        const results = [];
                        const request = store.openCursor();
                        
                        request.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (cursor) {
                                results.push({
                                    url: cursor.value.url,
                                    lastAccessed: cursor.value.lastAccessed,
                                    accessCount: cursor.value.accessCount,
                                    score: cursor.value.lastAccessed + (cursor.value.accessCount * 86400000) // Boost frequently accessed
                                });
                                cursor.continue();
                            } else {
                                resolve(results);
                            }
                        };
                    });

                    // Sort by LRU score and remove oldest
                    entries.sort((a, b) => a.score - b.score);
                    const toDelete = entries.slice(0, count - this.config.MAX_CACHED_LINKS);

                    for (const entry of toDelete) {
                        store.delete(entry.url);
                    }

                    this.log(`Cleaned up ${toDelete.length} old cache entries`);
                }
            } catch (error) {
                this.logError('Cleanup failed:', error);
            }
        }

        // Initialize cleanup web worker
        initCleanupWorker() {
            if ('Worker' in window) {
                try {
                    const workerCode = `
                        self.onmessage = function(e) {
                            if (e.data.type === 'CLEANUP') {
                                // Implement IndexedDB cleanup in worker
                                // This is a simplified version - full implementation would mirror main thread logic
                                self.postMessage({ type: 'CLEANUP_COMPLETE', success: true });
                            }
                        };
                    `;
                    
                    const blob = new Blob([workerCode], { type: 'application/javascript' });
                    this.cleanupWorker = new Worker(URL.createObjectURL(blob));
                    
                    this.cleanupWorker.onmessage = (e) => {
                        if (e.data.type === 'CLEANUP_COMPLETE') {
                            this.log('Background cleanup completed');
                        }
                    };
                } catch (error) {
                    this.logError('Failed to create cleanup worker:', error);
                }
            }
        }

        // Enhanced cache invalidation
        async invalidateCache(urlPattern) {
            if (!this.db) return;

            try {
                const transaction = this.db.transaction([this.config.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(DEFAULT_CONFIG.STORE_NAME);
                
                const request = store.openCursor();
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (cursor.value.url.match(urlPattern)) {
                            cursor.delete();
                            this.prefetchedUrls.delete(cursor.value.url);
                        }
                        cursor.continue();
                    }
                };

                // Also notify service worker
                if (this.broadcastChannel) {
                    this.broadcastChannel.postMessage({
                        type: 'INVALIDATE_CACHE',
                        pattern: urlPattern.toString()
                    });
                }
            } catch (error) {
                this.logError('Cache invalidation failed:', error);
            }
        }

        // Visual feedback system
        showVisualFeedback(message) {
            if (!this.config.VISUAL_FEEDBACK) return;

            // Create or update feedback element
            let feedback = document.getElementById('velocity-cache-feedback');
            if (!feedback) {
                feedback = document.createElement('div');
                feedback.id = 'velocity-cache-feedback';
                feedback.style.cssText = `
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    background: rgba(0, 100, 200, 0.9);
                    color: white;
                    padding: 8px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    z-index: 10000;
                    transition: opacity 0.3s ease;
                    pointer-events: none;
                `;
                document.body.appendChild(feedback);
            }

            feedback.textContent = message;
            feedback.style.opacity = '1';
            
            clearTimeout(feedback.hideTimeout);
            feedback.hideTimeout = setTimeout(() => {
                feedback.style.opacity = '0';
            }, 2000);
        }

        // Performance entry handler
        handlePerformanceEntry(entry) {
            if (entry.entryType === 'resource') {
                // Update analytics with actual load times
                const analytics = this.urlAnalytics.get(entry.name) || {
                    visitCount: 0,
                    totalLoadTime: 0,
                    avgLoadTime: 0
                };
                
                analytics.visitCount++;
                analytics.totalLoadTime += entry.duration;
                analytics.avgLoadTime = analytics.totalLoadTime / analytics.visitCount;
                
                this.urlAnalytics.set(entry.name, analytics);
            }
        }

        // Broadcast message handler
        handleBroadcastMessage(event) {
            const { type, data } = event.data;
            
            switch (type) {
                case 'PREFETCH_COMPLETE':
                    this.log('SW prefetch completed:', data.url);
                    break;
                case 'CACHE_UPDATED':
                    this.log('Cache updated:', data.url);
                    break;
                case 'ERROR':
                    this.logError('SW error:', data.error);
                    break;
            }
        }

        // Cleanup scheduler
        startCleanupScheduler() {
            setInterval(() => {
                this.cleanupOldEntries();
            }, this.config.CLEANUP_INTERVAL);
        }

        // Pause/resume functionality
        pausePrefetching() {
            this.isPaused = true;
            this.log('Prefetching paused');
        }

        resumePrefetching() {
            this.isPaused = false;
            this.processQueue(); // Process any queued items
            this.log('Prefetching resumed');
        }

        // Public API methods
        async getCacheStats() {
            if (!this.db) return null;

            try {
                const transaction = this.db.transaction([this.config.STORE_NAME], 'readonly');
                const store = transaction.objectStore(DEFAULT_CONFIG.STORE_NAME);
                
                const count = await new Promise((resolve) => {
                    const request = store.count();
                    request.onsuccess = () => resolve(request.result);
                });

                return {
                    totalEntries: count,
                    prefetchedUrls: this.prefetchedUrls.size,
                    queueSize: this.prefetchQueue.size,
                    analytics: Object.fromEntries(this.urlAnalytics)
                };
            } catch (error) {
                this.logError('Failed to get cache stats:', error);
                return null;
            }
        }

        // Update configuration
        updateConfig(newConfig) {
            this.config = { ...this.config, ...newConfig };
            this.log('Configuration updated:', newConfig);
        }

        // Destroy instance
        destroy() {
            // Clean up resources
            this.broadcastChannel?.close();
            this.performanceObserver?.disconnect();
            this.intersectionObserver?.disconnect();
            this.cleanupWorker?.terminate();
            this.db?.close();
            
            this.log('Velocity destroyed');
        }

        // Utility methods (keeping existing implementations but enhanced)
        findLinkElement(element) {
            while (element && element !== document) {
                if (element.tagName === 'A' && element.href) {
                    return element;
                }
                element = element.parentElement;
            }
            return null;
        }

        isValidUrl(url) {
            try {
                const parsed = new URL(url, window.location.origin);
                return parsed.origin === window.location.origin && 
                       parsed.protocol === window.location.protocol &&
                       !url.includes('javascript:') &&
                       !url.includes('data:') &&
                       !url.includes('blob:') &&
                       !url.includes('vbscript:');
            } catch {
                return false;
            }
        }

        sanitizeUrl(url) {
            const parsed = new URL(url, window.location.origin);
            // Remove potential XSS vectors and normalize
            return parsed.href.replace(/[<>"'`]/g, '').split('#')[0];
        }

        async fetchAndSanitizeContent(url) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.config.PREFETCH_TIMEOUT);
                
                const response = await fetch(url, { 
                    method: 'GET',
                    credentials: 'same-origin',
                    signal: controller.signal,
                    headers: {
                        'Cache-Control': 'no-cache'
                    }
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) return null;
                
                const content = await response.text();
                return this.sanitizeHtml(content);
            } catch (error) {
                if (error.name === 'AbortError') {
                    this.log('Fetch aborted for:', url);
                } else {
                    this.logError('Failed to fetch content:', error);
                }
                return null;
            }
        }

        async updateAnalytics(url) {
            // Update usage analytics
            const analytics = this.urlAnalytics.get(url) || {
                visitCount: 0,
                lastVisit: 0
            };
            
            analytics.visitCount++;
            analytics.lastVisit = Date.now();
            
            this.urlAnalytics.set(url, analytics);
            
            // Store in IndexedDB analytics store
            if (this.db) {
                try {
                    const transaction = this.db.transaction([this.config.ANALYTICS_STORE], 'readwrite');
                    const store = transaction.objectStore(this.config.ANALYTICS_STORE);
                    store.put({ url, ...analytics });
                } catch (error) {
                    this.logError('Failed to update analytics:', error);
                }
            }
        }

        async prerenderPage(url) {
            if (this.prerenderedUrls.has(url)) return;

            try {
                // Remove old prerender links
                document.querySelectorAll('link[rel="prerender"]').forEach(link => link.remove());

                // Add new prerender link with better attributes
                const link = document.createElement('link');
                link.rel = 'prerender';
                link.href = url;
                link.crossOrigin = 'anonymous';
                document.head.appendChild(link);

                this.prerenderedUrls.add(url);
                
                // Clean up after timeout
                setTimeout(() => {
                    if (link.parentNode) {
                        link.remove();
                    }
                    this.prerenderedUrls.delete(url);
                }, 30000);

                this.log('Prerendering:', url);
            } catch (error) {
                this.logError('Prerender failed:', error);
            }
        }
    }

    // Enhanced initialization with configuration support
    function initVelocity(config = {}) {
        if (window.VelocityInstance) {
            window.VelocityInstance.destroy();
        }
        
        window.VelocityInstance = new Velocity(config);
        return window.VelocityInstance;
    }

    // Auto-initialize with default config
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initVelocity();
        });
    } else {
        initVelocity();
    }

    // Expose public API
    window.Velocity = {
        init: initVelocity,
        getInstance: () => window.VelocityInstance,
        version: '1.0.0'
    };

})();