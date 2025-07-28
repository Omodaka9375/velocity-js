// velocity-cache-sw.js - Enhanced Service Worker for VelocityCache v2.0
'use strict';

// Configuration
const SW_CONFIG = {
    VERSION: '1.0.0',
    CACHE_NAMES: {
        STATIC: 'velocity-static-v1',
        DYNAMIC: 'velocity-dynamic-v1',
        PREFETCH: 'velocity-prefetch-v1',
        API: 'velocity-api-v1'
    },
    MAX_CACHE_SIZES: {
        STATIC: 50,
        DYNAMIC: 100,
        PREFETCH: 200,
        API: 30
    },
    TIMEOUTS: {
        FETCH: 5000,
        PREFETCH: 8000,
        BACKGROUND_SYNC: 30000
    },
    STRATEGY_TIMEOUTS: {
        NETWORK_FIRST: 3000,
        CACHE_FIRST: 1000
    },
    CLEANUP_INTERVAL: 300000, // 5 minutes
    PERFORMANCE_BUDGET: 50 // Max concurrent operations
};

// Global state
let broadcastChannel;
let performanceCounter = 0;
let prefetchQueue = new Map();
let cacheMetrics = new Map();
let isOnline = true;

// Register event listeners during initial script evaluation
self.addEventListener('install', (event) => {
    console.log('[VelocityCache SW] Installing v' + SW_CONFIG.VERSION);
    
    event.waitUntil(
        Promise.all([
            initializeCaches(),
            initializeBroadcastChannel(),
            self.skipWaiting()
        ])
    );
});

self.addEventListener('activate', (event) => {
    console.log('[VelocityCache SW] Activating v' + SW_CONFIG.VERSION);
    
    event.waitUntil(
        Promise.all([
            cleanupOldCaches(),
            startPeriodicCleanup(),
            self.clients.claim()
        ])
    );
});

// Register online/offline listeners during initial script evaluation
self.addEventListener('online', () => {
    console.log('[VelocityCache SW] Network online');
    isOnline = true;
    broadcastMessage({ type: 'ONLINE_STATUS', isOnline: true });
});

self.addEventListener('offline', () => {
    console.log('[VelocityCache SW] Network offline');
    isOnline = false;
    broadcastMessage({ type: 'ONLINE_STATUS', isOnline: false });
});

// Register fetch event listener during initial script evaluation
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    
    // Skip non-GET requests and different origins
    if (request.method !== 'GET' || url.origin !== self.location.origin) {
        return;
    }
    
    // Skip if cache should be bypassed
    if (shouldBypassCache(request)) {
        event.respondWith(
            fetchWithTimeout(request, SW_CONFIG.TIMEOUTS.FETCH)
                .catch(() => createOfflineResponse(request))
        );
        return;
    }
    
    event.respondWith(handleFetchWithStrategy(request));
});

// Register background sync listeners during initial script evaluation
if ('sync' in self.registration) {
    self.addEventListener('sync', (event) => {
        if (event.tag === 'velocity-cache-cleanup') {
            event.waitUntil(handleBackgroundCleanup());
        } else if (event.tag === 'velocity-cache-prefetch') {
            event.waitUntil(processPrefetchQueue());
        }
    });
}

// Register error handling during initial script evaluation
self.addEventListener('unhandledrejection', (event) => {
    console.error('[VelocityCache SW] Unhandled promise rejection:', event.reason);
    event.preventDefault();
});

// Initialize caches with predefined structure
async function initializeCaches() {
    try {
        // Pre-warm critical caches
        await Promise.all([
            caches.open(SW_CONFIG.CACHE_NAMES.STATIC),
            caches.open(SW_CONFIG.CACHE_NAMES.DYNAMIC),
            caches.open(SW_CONFIG.CACHE_NAMES.PREFETCH),
            caches.open(SW_CONFIG.CACHE_NAMES.API)
        ]);
        
        console.log('[VelocityCache SW] Caches initialized');
    } catch (error) {
        console.error('[VelocityCache SW] Cache initialization failed:', error);
    }
}

// Initialize BroadcastChannel for efficient communication
function initializeBroadcastChannel() {
    try {
        broadcastChannel = new BroadcastChannel('velocity-cache-channel');
        broadcastChannel.onmessage = handleBroadcastMessage;
        console.log('[VelocityCache SW] BroadcastChannel initialized');
    } catch (error) {
        console.error('[VelocityCache SW] BroadcastChannel failed:', error);
        // Fallback to postMessage will be handled automatically
    }
}

// Clean up old cache versions
async function cleanupOldCaches() {
    try {
        const cacheNames = await caches.keys();
        const currentCaches = Object.values(SW_CONFIG.CACHE_NAMES);
        
        const deletionPromises = cacheNames
            .filter(cacheName => !currentCaches.includes(cacheName))
            .map(cacheName => {
                console.log('[VelocityCache SW] Deleting old cache:', cacheName);
                return caches.delete(cacheName);
            });
        
        await Promise.all(deletionPromises);
        console.log('[VelocityCache SW] Old caches cleaned up');
    } catch (error) {
        console.error('[VelocityCache SW] Cache cleanup failed:', error);
    }
}

// Smart fetch strategy selector
async function handleFetchWithStrategy(request) {
    const url = new URL(request.url);
    const requestType = classifyRequest(request);
    
    try {
        switch (requestType) {
            case 'static':
                return await cacheFirstStrategy(request, SW_CONFIG.CACHE_NAMES.STATIC);
            
            case 'html':
                return await networkFirstStrategy(request, SW_CONFIG.CACHE_NAMES.DYNAMIC);
            
            case 'api':
                return await networkFirstStrategy(request, SW_CONFIG.CACHE_NAMES.API, true);
            
            case 'prefetch':
                return await staleWhileRevalidateStrategy(request, SW_CONFIG.CACHE_NAMES.PREFETCH);
            
            case 'image':
            case 'media':
                return await cacheFirstStrategy(request, SW_CONFIG.CACHE_NAMES.STATIC);
            
            default:
                return await networkFirstStrategy(request, SW_CONFIG.CACHE_NAMES.DYNAMIC);
        }
    } catch (error) {
        console.error('[VelocityCache SW] Fetch strategy failed:', error);
        return await createOfflineResponse(request);
    }
}

// Cache First Strategy - optimized for static assets
async function cacheFirstStrategy(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
        // Update cache in background if resource is stale
        if (isResourceStale(cachedResponse)) {
            updateCacheInBackground(request, cache);
        }
        
        recordCacheHit(request.url);
        return cachedResponse;
    }
    
    // Fetch and cache if not found
    try {
        const networkResponse = await fetchWithTimeout(request, SW_CONFIG.TIMEOUTS.FETCH);
        
        if (networkResponse && networkResponse.status === 200) {
            await safeCachePut(cache, request, networkResponse.clone(), cacheName);
        }
        
        recordCacheMiss(request.url);
        return networkResponse;
        
    } catch (error) {
        console.error('[VelocityCache SW] Cache first fallback failed:', error);
        return createOfflineResponse(request);
    }
}

// Network First Strategy - optimized for dynamic content
async function networkFirstStrategy(request, cacheName, isAPI = false) {
    const cache = await caches.open(cacheName);
    const timeout = isAPI ? SW_CONFIG.STRATEGY_TIMEOUTS.NETWORK_FIRST / 2 : SW_CONFIG.STRATEGY_TIMEOUTS.NETWORK_FIRST;
    
    try {
        const networkResponse = await fetchWithTimeout(request, timeout);
        
        if (networkResponse && networkResponse.status === 200) {
            // Cache successful responses
            if (shouldCacheResponse(request, networkResponse, isAPI)) {
                await safeCachePut(cache, request, networkResponse.clone(), cacheName);
            }
            
            recordNetworkSuccess(request.url);
            return networkResponse;
        }
        
        // If network response is not successful, try cache
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            recordCacheFallback(request.url);
            return cachedResponse;
        }
        
        return networkResponse;
        
    } catch (error) {
        // Network failed, try cache
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            recordCacheFallback(request.url);
            return cachedResponse;
        }
        
        console.error('[VelocityCache SW] Network first strategy failed:', error);
        return createOfflineResponse(request);
    }
}

// Stale While Revalidate Strategy - best for prefetched content
async function staleWhileRevalidateStrategy(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request);
    
    // Always try to fetch in background
    const networkPromise = fetchWithTimeout(request, SW_CONFIG.TIMEOUTS.FETCH)
        .then(response => {
            if (response && response.status === 200) {
                safeCachePut(cache, request, response.clone(), cacheName);
            }
            return response;
        })
        .catch(error => {
            console.log('[VelocityCache SW] Background revalidation failed:', error.message);
            return null;
        });
    
    // Return cached version immediately if available
    if (cachedResponse) {
        recordCacheHit(request.url);
        return cachedResponse;
    }
    
    // If no cache, wait for network
    try {
        const networkResponse = await networkPromise;
        recordNetworkSuccess(request.url);
        return networkResponse || createOfflineResponse(request);
    } catch (error) {
        return createOfflineResponse(request);
    }
}

// Enhanced fetch with timeout and retry logic
async function fetchWithTimeout(request, timeout = SW_CONFIG.TIMEOUTS.FETCH, retries = 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(request, {
            signal: controller.signal,
            credentials: 'same-origin',
            headers: {
                ...Object.fromEntries(request.headers.entries()),
                'Cache-Control': 'no-cache',
                'X-Requested-With': 'VelocityCache-SW'
            }
        });
        
        clearTimeout(timeoutId);
        return response;
        
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (retries > 0 && error.name !== 'AbortError') {
            console.log(`[VelocityCache SW] Retrying fetch for ${request.url}`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
            return fetchWithTimeout(request, timeout, retries - 1);
        }
        
        throw error;
    }
}

// Safe cache put with size management
async function safeCachePut(cache, request, response, cacheName) {
    try {
        // Check performance budget
        if (performanceCounter >= SW_CONFIG.PERFORMANCE_BUDGET) {
            console.log('[VelocityCache SW] Performance budget exceeded, skipping cache put');
            return;
        }
        
        performanceCounter++;
        
        // Manage cache size before adding new entry
        await manageCacheSize(cache, cacheName);
        
        // Clone response to avoid consumption issues
        const responseToCache = response.clone();
        
        // Add cache metadata
        const headers = new Headers(responseToCache.headers);
        headers.set('X-VelocityCache-Timestamp', Date.now().toString());
        headers.set('X-VelocityCache-Version', SW_CONFIG.VERSION);
        
        const enhancedResponse = new Response(responseToCache.body, {
            status: responseToCache.status,
            statusText: responseToCache.statusText,
            headers: headers
        });
        
        await cache.put(request, enhancedResponse);
        
        // Broadcast cache update
        broadcastCacheUpdate(request.url, 'CACHED');
        
    } catch (error) {
        console.error('[VelocityCache SW] Cache put failed:', error);
    } finally {
        performanceCounter--;
    }
}

// Intelligent cache size management
async function manageCacheSize(cache, cacheName) {
    try {
        const keys = await cache.keys();
        const maxSize = SW_CONFIG.MAX_CACHE_SIZES[cacheName.split('-').pop().toUpperCase()] || 50;
        
        if (keys.length >= maxSize) {
            // Sort by usage metrics (LRU + access frequency)
            const keysWithMetrics = await Promise.all(
                keys.map(async (request) => {
                    const response = await cache.match(request);
                    const timestamp = response?.headers.get('X-VelocityCache-Timestamp') || '0';
                    const metrics = cacheMetrics.get(request.url) || { hits: 0, lastAccess: 0 };
                    
                    return {
                        request,
                        timestamp: parseInt(timestamp),
                        score: calculateEvictionScore(metrics, parseInt(timestamp))
                    };
                })
            );
            
            // Sort by eviction score (lower = evict first)
            keysWithMetrics.sort((a, b) => a.score - b.score);
            
            // Remove oldest entries
            const toEvict = keysWithMetrics.slice(0, keys.length - maxSize + 5); // Remove extra for buffer
            
            await Promise.all(
                toEvict.map(async ({ request }) => {
                    await cache.delete(request);
                    cacheMetrics.delete(request.url);
                })
            );
            
            console.log(`[VelocityCache SW] Evicted ${toEvict.length} entries from ${cacheName}`);
        }
    } catch (error) {
        console.error('[VelocityCache SW] Cache size management failed:', error);
    }
}

// Calculate eviction score (lower score = higher eviction priority)
function calculateEvictionScore(metrics, timestamp) {
    const age = Date.now() - timestamp;
    const ageScore = age / (1000 * 60 * 60); // Hours since cached
    const accessScore = metrics.hits * 10; // Boost frequently accessed items
    const recentAccessScore = (Date.now() - metrics.lastAccess) / (1000 * 60); // Minutes since last access
    
    return ageScore + recentAccessScore - accessScore;
}

// Enhanced BroadcastChannel message handler
function handleBroadcastMessage(event) {
    const { type, url, priority, messageId, pattern } = event.data;
    
    switch (type) {
        case 'PREFETCH':
            handlePrefetchRequest(url, priority, messageId);
            break;
            
        case 'PRERENDER':
            handlePrerenderRequest(url, messageId);
            break;
            
        case 'INVALIDATE_CACHE':
            handleCacheInvalidation(pattern, messageId);
            break;
            
        case 'GET_CACHE_STATS':
            handleCacheStatsRequest(messageId);
            break;
            
        case 'FORCE_REFRESH':
            handleForceRefresh(url, messageId);
            break;
            
        case 'CLEANUP_CACHE':
            handleManualCleanup(messageId);
            break;
            
        default:
            console.log('[VelocityCache SW] Unknown message type:', type);
    }
}

// Enhanced prefetch handler with queue management
async function handlePrefetchRequest(url, priority = 1, messageId) {
    if (!url || !isValidUrl(url)) {
        broadcastResponse(messageId, false, 'Invalid URL');
        return;
    }
    
    try {
        // Add to prefetch queue with priority
        prefetchQueue.set(url, {
            url,
            priority,
            messageId,
            timestamp: Date.now()
        });
        
        // Process queue
        await processPrefetchQueue();
        
    } catch (error) {
        console.error('[VelocityCache SW] Prefetch failed:', error);
        broadcastResponse(messageId, false, error.message);
    }
}

// Process prefetch queue with priority and concurrency control
async function processPrefetchQueue() {
    if (performanceCounter >= SW_CONFIG.PERFORMANCE_BUDGET * 0.7) {
        return; // Preserve performance budget
    }
    
    // Sort by priority (higher first)
    const sortedQueue = Array.from(prefetchQueue.entries())
        .sort(([,a], [,b]) => b.priority - a.priority);
    
    // Process top priority items
    const concurrentLimit = Math.min(3, SW_CONFIG.PERFORMANCE_BUDGET - performanceCounter);
    const batch = sortedQueue.slice(0, concurrentLimit);
    
    const promises = batch.map(async ([url, item]) => {
        prefetchQueue.delete(url);
        return executePrefetch(item);
    });
    
    await Promise.allSettled(promises);
}

// Execute individual prefetch operation
async function executePrefetch({ url, messageId, priority }) {
    try {
        performanceCounter++;
        
        const cache = await caches.open(SW_CONFIG.CACHE_NAMES.PREFETCH);
        
        // Check if already cached
        const cached = await cache.match(url);
        if (cached && !isResourceStale(cached)) {
            broadcastResponse(messageId, true, 'Already cached');
            return;
        }
        
        // Fetch resource
        const request = new Request(url, {
            mode: 'cors',
            credentials: 'same-origin'
        });
        
        const response = await fetchWithTimeout(request, SW_CONFIG.TIMEOUTS.PREFETCH);
        
        if (response && response.status === 200) {
            await safeCachePut(cache, request, response, SW_CONFIG.CACHE_NAMES.PREFETCH);
            
            // Prefetch critical subresources for high priority items
            if (priority >= 8) {
                prefetchSubresources(url, response.clone());
            }
            
            broadcastResponse(messageId, true, 'Prefetched successfully');
        } else {
            broadcastResponse(messageId, false, `HTTP ${response?.status || 'Network Error'}`);
        }
        
    } catch (error) {
        console.error('[VelocityCache SW] Prefetch execution failed:', error);
        broadcastResponse(messageId, false, error.message);
    } finally {
        performanceCounter--;
    }
}

// Prefetch critical subresources
async function prefetchSubresources(url, response) {
    try {
        const html = await response.text();
        const subresources = extractCriticalSubresources(html, url);
        
        // Limit subresource prefetching
        const criticalResources = subresources.slice(0, 3);
        
        const promises = criticalResources.map(resourceUrl =>
            executePrefetch({
                url: resourceUrl,
                priority: 3, // Lower priority for subresources
                messageId: null
            })
        );
        
        await Promise.allSettled(promises);
        
    } catch (error) {
        console.log('[VelocityCache SW] Subresource prefetch failed:', error.message);
    }
}

// Extract critical subresources from HTML
function extractCriticalSubresources(html, baseUrl) {
    const resources = [];
    const base = new URL(baseUrl);
    
    try {
        // Extract critical CSS (first 2 stylesheets)
        const cssMatches = html.match(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi);
        if (cssMatches) {
            cssMatches.slice(0, 2).forEach(match => {
                const href = match.match(/href=["']([^"']+)["']/)?.[1];
                if (href) {
                    try {
                        resources.push(new URL(href, base).href);
                    } catch (e) {
                        // Invalid URL, skip
                    }
                }
            });
        }
        
        // Extract critical JavaScript (first script only)
        const jsMatches = html.match(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi);
        if (jsMatches && jsMatches[0]) {
            const src = jsMatches[0].match(/src=["']([^"']+)["']/)?.[1];
            if (src) {
                try {
                    resources.push(new URL(src, base).href);
                } catch (e) {
                    // Invalid URL, skip
                }
            }
        }
        
    } catch (error) {
        console.error('[VelocityCache SW] Subresource extraction failed:', error);
    }
    
    return resources.filter(url => isValidUrl(url));
}

// Handle cache invalidation with pattern matching
async function handleCacheInvalidation(pattern, messageId) {
    try {
        const regex = new RegExp(pattern);
        const cacheNames = Object.values(SW_CONFIG.CACHE_NAMES);
        let invalidatedCount = 0;
        
        for (const cacheName of cacheNames) {
            const cache = await caches.open(cacheName);
            const keys = await cache.keys();
            
            for (const request of keys) {
                if (regex.test(request.url)) {
                    await cache.delete(request);
                    cacheMetrics.delete(request.url);
                    invalidatedCount++;
                }
            }
        }
        
        broadcastResponse(messageId, true, `Invalidated ${invalidatedCount} entries`);
        
    } catch (error) {
        console.error('[VelocityCache SW] Cache invalidation failed:', error);
        broadcastResponse(messageId, false, error.message);
    }
}

// Handle cache statistics request
async function handleCacheStatsRequest(messageId) {
    try {
        const stats = {};
        const cacheNames = Object.values(SW_CONFIG.CACHE_NAMES);
        
        for (const cacheName of cacheNames) {
            const cache = await caches.open(cacheName);
            const keys = await cache.keys();
            
            stats[cacheName] = {
                size: keys.length,
                maxSize: SW_CONFIG.MAX_CACHE_SIZES[cacheName.split('-').pop().toUpperCase()] || 50,
                urls: keys.slice(0, 5).map(req => req.url) // Sample URLs
            };
        }
        
        broadcastMessage({
            type: 'CACHE_STATS',
            messageId,
            stats,
            metrics: Object.fromEntries(Array.from(cacheMetrics.entries()).slice(0, 20)),
            performance: {
                activeOperations: performanceCounter,
                queueSize: prefetchQueue.size,
                isOnline
            }
        });
        
    } catch (error) {
        console.error('[VelocityCache SW] Cache stats failed:', error);
        broadcastResponse(messageId, false, error.message);
    }
}

// Placeholder handlers for missing functions
async function handlePrerenderRequest(url, messageId) {
    // Implement prerender logic similar to prefetch
    await handlePrefetchRequest(url, 8, messageId); // High priority
}

async function handleForceRefresh(url, messageId) {
    try {
        // Force refresh by invalidating and refetching
        const cacheNames = Object.values(SW_CONFIG.CACHE_NAMES);
        for (const cacheName of cacheNames) {
            const cache = await caches.open(cacheName);
            await cache.delete(url);
        }
        
        // Prefetch fresh version
        await handlePrefetchRequest(url, 10, messageId);
    } catch (error) {
        broadcastResponse(messageId, false, error.message);
    }
}

async function handleManualCleanup(messageId) {
    try {
        await handleBackgroundCleanup();
        broadcastResponse(messageId, true, 'Cleanup completed');
    } catch (error) {
        broadcastResponse(messageId, false, error.message);
    }
}

// Utility functions
function classifyRequest(request) {
    const url = new URL(request.url);
    const pathname = url.pathname.toLowerCase();
    const accept = request.headers.get('Accept') || '';
    
    if (pathname.match(/\.(css|js|woff2?|ttf|eot)$/)) return 'static';
    if (pathname.match(/\.(png|jpe?g|gif|webp|svg|ico)$/)) return 'image';
    if (pathname.match(/\.(mp4|webm|mp3|wav|ogg)$/)) return 'media';
    if (pathname.startsWith('/api/') || pathname.includes('/graphql')) return 'api';
    if (accept.includes('text/html')) return 'html';
    if (request.headers.get('X-Prefetch-Source')) return 'prefetch';
    
    return 'dynamic';
}

function shouldBypassCache(request) {
    const url = new URL(request.url);
    
    return url.searchParams.has('no-cache') ||
           url.searchParams.has('cache-bust') ||
           url.pathname.includes('/admin/') ||
           url.pathname.includes('/login') ||
           request.headers.get('Cache-Control') === 'no-cache';
}

function shouldCacheResponse(request, response, isAPI = false) {
    if (!response || response.status !== 200) return false;
    if (response.headers.get('Cache-Control')?.includes('no-store')) return false;
    
    if (isAPI) {
        // Only cache GET API requests with specific patterns
        const url = new URL(request.url);
        return url.pathname.includes('/public/') || 
               url.pathname.includes('/config/') ||
               url.pathname.includes('/static-data/');
    }
    
    return true;
}

function isResourceStale(response, maxAge = 3600000) { // 1 hour default
    const timestamp = response.headers.get('X-VelocityCache-Timestamp');
    if (!timestamp) return true;
    
    return (Date.now() - parseInt(timestamp)) > maxAge;
}

function isValidUrl(url) {
    try {
        const parsed = new URL(url, self.location.origin);
        return parsed.origin === self.location.origin &&
               parsed.protocol === self.location.protocol &&
               !url.includes('javascript:') &&
               !url.includes('data:') &&
               !url.includes('blob:');
    } catch {
        return false;
    }
}

// Performance and metrics tracking
function recordCacheHit(url) {
    const metrics = cacheMetrics.get(url) || { hits: 0, misses: 0, lastAccess: 0 };
    metrics.hits++;
    metrics.lastAccess = Date.now();
    cacheMetrics.set(url, metrics);
}

function recordCacheMiss(url) {
    const metrics = cacheMetrics.get(url) || { hits: 0, misses: 0, lastAccess: 0 };
    metrics.misses++;
    cacheMetrics.set(url, metrics);
}

function recordNetworkSuccess(url) {
    const metrics = cacheMetrics.get(url) || { hits: 0, misses: 0, networkSuccess: 0 };
    metrics.networkSuccess = (metrics.networkSuccess || 0) + 1;
    cacheMetrics.set(url, metrics);
}

function recordCacheFallback(url) {
    const metrics = cacheMetrics.get(url) || { hits: 0, misses: 0, fallbacks: 0 };
    metrics.fallbacks = (metrics.fallbacks || 0) + 1;
    cacheMetrics.set(url, metrics);
}

// Background cache updates
async function updateCacheInBackground(request, cache) {
    try {
        const response = await fetchWithTimeout(request, SW_CONFIG.TIMEOUTS.FETCH);
        if (response && response.status === 200) {
            await safeCachePut(cache, request, response, cache.name || 'unknown');
            broadcastCacheUpdate(request.url, 'UPDATED');
        }
    } catch (error) {
        // Silent failure for background updates
        console.log('[VelocityCache SW] Background update failed:', error.message);
    }
}

// Create offline response
function createOfflineResponse(request) {
    const url = new URL(request.url);
    const accept = request.headers.get('Accept') || '';
    
    if (accept.includes('text/html')) {
        return new Response(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Offline - VelocityCache</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }
                    .offline { color: #666; }
                </style>
            </head>
            <body>
                <div class="offline">
                    <h1>You're offline</h1>
                    <p>This page is not available offline.</p>
                    <p>Please check your connection and try again.</p>
                </div>
            </body>
            </html>
        `, {
            status: 503,
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    // JSON response for API requests
    if (accept.includes('application/json') || url.pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({
            error: 'offline',
            message: 'This content is not available offline',
            timestamp: Date.now()
        }), {
            status: 503,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    // Generic offline response
    return new Response('Offline - Content not available', {
        status: 503,
        headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-cache'
        }
    });
}

// Broadcasting utilities
function broadcastMessage(data) {
    if (broadcastChannel) {
        try {
            broadcastChannel.postMessage(data);
        } catch (error) {
            console.error('[VelocityCache SW] Broadcast failed:', error);
        }
    }
    
    // Fallback to client messaging
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            try {
                client.postMessage(data);
            } catch (error) {
                console.error('[VelocityCache SW] Client message failed:', error);
            }
        });
    }).catch(error => {
        console.error('[VelocityCache SW] Client matchAll failed:', error);
    });
}

function broadcastResponse(messageId, success, message = '') {
    broadcastMessage({
        messageId,
        success,
        message,
        timestamp: Date.now()
    });
}

function broadcastCacheUpdate(url, action) {
    broadcastMessage({
        type: 'CACHE_UPDATE',
        url,
        action,
        timestamp: Date.now()
    });
}

// Periodic maintenance
function startPeriodicCleanup() {
    setInterval(async () => {
        try {
            // Clean up old metrics
            const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
            for (const [url, metrics] of cacheMetrics.entries()) {
                if (metrics.lastAccess < cutoff) {
                    cacheMetrics.delete(url);
                }
            }
            
            // Manage cache sizes
            const cacheNames = Object.values(SW_CONFIG.CACHE_NAMES);
            for (const cacheName of cacheNames) {
                const cache = await caches.open(cacheName);
                await manageCacheSize(cache, cacheName);
            }
            
            console.log('[VelocityCache SW] Periodic cleanup completed');
            
        } catch (error) {
            console.error('[VelocityCache SW] Periodic cleanup failed:', error);
        }
    }, SW_CONFIG.CLEANUP_INTERVAL);
}

async function handleBackgroundCleanup() {
    console.log('[VelocityCache SW] Background cleanup sync triggered');
    
    try {
        const cacheNames = Object.values(SW_CONFIG.CACHE_NAMES);
        for (const cacheName of cacheNames) {
            const cache = await caches.open(cacheName);
            await manageCacheSize(cache, cacheName);
        }
    } catch (error) {
        console.error('[VelocityCache SW] Background cleanup failed:', error);
    }
}

console.log('[VelocityCache SW] Service Worker v' + SW_CONFIG.VERSION + ' loaded');