// Mobile PWA Service Worker for Offline-First Competition Management
const CACHE_NAME = 'dope-mobile-v1.0.0'
const STATIC_CACHE = 'dope-static-v1.0.0'
const DYNAMIC_CACHE = 'dope-dynamic-v1.0.0'
const API_CACHE = 'dope-api-v1.0.0'

// Workbox will inject the manifest here
self.__WB_MANIFEST

// Critical resources that must be cached
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/src/assets/sounds/beep.mp3',
  '/src/assets/sounds/start-signal.mp3',
  '/src/assets/sounds/stop-signal.mp3'
]

// API endpoints that should be cached with different strategies
const API_ROUTES = {
  // Cache first - rarely changing data
  CACHE_FIRST: [
    '/api/competitions',
    '/api/divisions',
    '/api/stages',
    '/api/scoring-rules'
  ],
  // Network first - frequently changing data
  NETWORK_FIRST: [
    '/api/matches/current',
    '/api/scores/live',
    '/api/leaderboard',
    '/api/timer/status'
  ],
  // Network only - critical real-time data
  NETWORK_ONLY: [
    '/api/timer/start',
    '/api/timer/stop',
    '/api/scores/submit',
    '/api/penalties/add'
  ]
}

// Maximum cache sizes to prevent storage bloat
const CACHE_LIMITS = {
  [STATIC_CACHE]: 50,
  [DYNAMIC_CACHE]: 100,
  [API_CACHE]: 200
}

/**
 * Service Worker Installation
 */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing mobile service worker...')
  
  event.waitUntil(
    Promise.all([
      // Cache critical static assets
      caches.open(STATIC_CACHE).then((cache) => {
        console.log('[SW] Caching static assets')
        return cache.addAll(STATIC_ASSETS)
      }),
      
      // Initialize API cache
      caches.open(API_CACHE).then((cache) => {
        console.log('[SW] Initializing API cache')
        return cache.put('/api/offline-status', new Response(JSON.stringify({
          offline: true,
          timestamp: Date.now(),
          version: '1.0.0'
        }), {
          headers: { 'Content-Type': 'application/json' }
        }))
      }),
      
      // Skip waiting to activate immediately
      self.skipWaiting()
    ])
  )
})

/**
 * Service Worker Activation
 */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating mobile service worker...')
  
  event.waitUntil(
    Promise.all([
      // Clean up old caches
      cleanupOldCaches(),
      
      // Claim all clients immediately
      self.clients.claim(),
      
      // Initialize offline storage
      initializeOfflineStorage()
    ])
  )
})

/**
 * Fetch Event Handler - Main request interceptor
 */
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  
  // Skip non-GET requests for caching
  if (request.method !== 'GET' && !isApiRequest(url)) {
    return handleNonGetRequest(event)
  }
  
  // Route to appropriate caching strategy
  if (isApiRequest(url)) {
    event.respondWith(handleApiRequest(request, url))
  } else if (isStaticAsset(url)) {
    event.respondWith(handleStaticAsset(request))
  } else if (isPageRequest(request)) {
    event.respondWith(handlePageRequest(request))
  } else {
    event.respondWith(handleDynamicAsset(request))
  }
})

/**
 * Background Sync for Offline Data
 */
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync triggered:', event.tag)
  
  switch (event.tag) {
    case 'score-submission':
      event.waitUntil(syncOfflineScores())
      break
    case 'timer-events':
      event.waitUntil(syncTimerEvents())
      break
    default:
      console.log('[SW] Unknown sync tag:', event.tag)
  }
})

/**
 * Push Notifications for Match Updates
 */
self.addEventListener('push', (event) => {
  console.log('[SW] Push notification received')
  
  let notificationData = {
    title: 'DOPE Competition Update',
    body: 'New match information available',
    icon: '/favicon-192x192.png',
    tag: 'match-update',
    requireInteraction: true
  }
  
  if (event.data) {
    try {
      const data = event.data.json()
      notificationData = { ...notificationData, ...data }
    } catch (error) {
      console.error('[SW] Error parsing push data:', error)
    }
  }
  
  event.waitUntil(
    self.registration.showNotification(notificationData.title, {
      body: notificationData.body,
      icon: notificationData.icon,
      tag: notificationData.tag,
      requireInteraction: notificationData.requireInteraction,
      actions: [
        {
          action: 'view',
          title: 'View Details'
        },
        {
          action: 'dismiss',
          title: 'Dismiss'
        }
      ],
      data: notificationData
    })
  )
})

/**
 * Message Handler for Communication with Main App
 */
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data)
  
  switch (event.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting()
      break
      
    case 'CACHE_SCORE':
      cacheOfflineScore(event.data.payload)
      break
      
    case 'CACHE_TIMER_EVENT':
      cacheTimerEvent(event.data.payload)
      break
      
    case 'GET_OFFLINE_DATA':
      getOfflineData().then((data) => {
        event.ports[0].postMessage(data)
      })
      break
      
    default:
      console.log('[SW] Unknown message type:', event.data.type)
  }
})

/**
 * API Request Handler
 */
async function handleApiRequest(request, url) {
  const pathname = url.pathname
  
  // Determine caching strategy based on endpoint
  if (API_ROUTES.NETWORK_ONLY.some(route => pathname.startsWith(route))) {
    return handleNetworkOnly(request)
  } else if (API_ROUTES.CACHE_FIRST.some(route => pathname.startsWith(route))) {
    return handleCacheFirst(request)
  } else if (API_ROUTES.NETWORK_FIRST.some(route => pathname.startsWith(route))) {
    return handleNetworkFirst(request)
  } else {
    return handleNetworkFirst(request) // Default strategy
  }
}

/**
 * Cache-First Strategy
 */
async function handleCacheFirst(request) {
  const cache = await caches.open(API_CACHE)
  const cachedResponse = await cache.match(request)
  
  if (cachedResponse) {
    // Return cached version immediately
    fetchAndUpdateCache(request, cache) // Update in background
    return cachedResponse
  } else {
    // Fetch from network and cache
    return fetchAndCache(request, cache)
  }
}

/**
 * Network-First Strategy
 */
async function handleNetworkFirst(request) {
  const cache = await caches.open(API_CACHE)
  
  try {
    const networkResponse = await fetch(request)
    
    if (networkResponse.ok) {
      // Cache successful responses
      cache.put(request, networkResponse.clone())
      return networkResponse
    } else {
      throw new Error(`Network response not ok: ${networkResponse.status}`)
    }
  } catch (error) {
    console.log('[SW] Network failed, trying cache:', error)
    
    const cachedResponse = await cache.match(request)
    if (cachedResponse) {
      return cachedResponse
    } else {
      return createOfflineResponse(request)
    }
  }
}

/**
 * Network-Only Strategy
 */
async function handleNetworkOnly(request) {
  try {
    return await fetch(request)
  } catch (error) {
    console.log('[SW] Network-only request failed:', error)
    
    // Return appropriate offline response
    if (request.url.includes('/submit') || request.url.includes('/start') || request.url.includes('/stop')) {
      // Queue for background sync
      await queueForSync(request)
      
      return new Response(JSON.stringify({
        success: false,
        offline: true,
        queued: true,
        message: 'Request queued for when connection is restored'
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    return new Response(JSON.stringify({
      error: 'Network unavailable',
      offline: true
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * Static Asset Handler
 */
async function handleStaticAsset(request) {
  const cache = await caches.open(STATIC_CACHE)
  const cachedResponse = await cache.match(request)
  
  if (cachedResponse) {
    return cachedResponse
  }
  
  try {
    const networkResponse = await fetch(request)
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone())
    }
    return networkResponse
  } catch (error) {
    console.log('[SW] Failed to load static asset:', error)
    return createFallbackResponse(request)
  }
}

/**
 * Page Request Handler
 */
async function handlePageRequest(request) {
  const cache = await caches.open(DYNAMIC_CACHE)
  
  try {
    const networkResponse = await fetch(request)
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone())
    }
    return networkResponse
  } catch (error) {
    console.log('[SW] Page request failed, trying cache:', error)
    
    const cachedResponse = await cache.match(request)
    if (cachedResponse) {
      return cachedResponse
    }
    
    return createOfflineHtmlResponse()
  }
}

/**
 * Dynamic Asset Handler
 */
async function handleDynamicAsset(request) {
  const cache = await caches.open(DYNAMIC_CACHE)
  
  try {
    const networkResponse = await fetch(request)
    
    if (networkResponse.ok) {
      // Only cache successful responses and limit cache size
      await limitCacheSize(cache, CACHE_LIMITS[DYNAMIC_CACHE])
      cache.put(request, networkResponse.clone())
    }
    
    return networkResponse
  } catch (error) {
    const cachedResponse = await cache.match(request)
    return cachedResponse || createFallbackResponse(request)
  }
}

/**
 * Offline Score Caching
 */
async function cacheOfflineScore(scoreData) {
  try {
    const db = await openOfflineDB()
    const transaction = db.transaction(['scores'], 'readwrite')
    const store = transaction.objectStore('scores')
    
    await store.add({
      ...scoreData,
      timestamp: Date.now(),
      synced: false
    })
  } catch (error) {
    console.error('[SW] Failed to cache score:', error)
  }
}

/**
 * Offline Timer Event Caching
 */
async function cacheTimerEvent(eventData) {
  try {
    const db = await openOfflineDB()
    const transaction = db.transaction(['timer_events'], 'readwrite')
    const store = transaction.objectStore('timer_events')
    
    await store.add({
      ...eventData,
      timestamp: Date.now(),
      synced: false
    })
  } catch (error) {
    console.error('[SW] Failed to cache timer event:', error)
  }
}

/**
 * Sync Offline Scores
 */
async function syncOfflineScores() {
  console.log('[SW] Syncing offline scores...')
  
  try {
    const db = await openOfflineDB()
    const transaction = db.transaction(['scores'], 'readwrite')
    const store = transaction.objectStore('scores')
    const unsyncedScores = await getAllFromStore(store)
    
    for (const score of unsyncedScores.filter(s => !s.synced)) {
      try {
        const response = await fetch('/api/scores/submit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(score)
        })
        
        if (response.ok) {
          score.synced = true
          await store.put(score)
          console.log('[SW] Score synced successfully:', score.id)
        }
      } catch (error) {
        console.error('[SW] Failed to sync score:', error)
      }
    }
  } catch (error) {
    console.error('[SW] Sync scores failed:', error)
  }
}

/**
 * Sync Timer Events
 */
async function syncTimerEvents() {
  console.log('[SW] Syncing timer events...')
  
  try {
    const db = await openOfflineDB()
    const transaction = db.transaction(['timer_events'], 'readwrite')
    const store = transaction.objectStore('timer_events')
    const unsyncedEvents = await getAllFromStore(store)
    
    for (const event of unsyncedEvents.filter(e => !e.synced)) {
      try {
        const response = await fetch('/api/timer/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(event)
        })
        
        if (response.ok) {
          event.synced = true
          await store.put(event)
          console.log('[SW] Timer event synced successfully:', event.id)
        }
      } catch (error) {
        console.error('[SW] Failed to sync timer event:', error)
      }
    }
  } catch (error) {
    console.error('[SW] Sync timer events failed:', error)
  }
}

/**
 * Utility Functions
 */

function isApiRequest(url) {
  return url.pathname.startsWith('/api/')
}

function isStaticAsset(url) {
  const staticExtensions = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.woff', '.woff2', '.mp3', '.wav']
  return staticExtensions.some(ext => url.pathname.endsWith(ext))
}

function isPageRequest(request) {
  return request.destination === 'document' || 
         request.headers.get('accept')?.includes('text/html')
}

async function fetchAndCache(request, cache) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    throw error
  }
}

async function fetchAndUpdateCache(request, cache) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      cache.put(request, response.clone())
    }
  } catch (error) {
    console.log('[SW] Background update failed:', error)
  }
}

async function limitCacheSize(cache, maxItems) {
  const keys = await cache.keys()
  if (keys.length >= maxItems) {
    // Remove oldest entries
    const keysToDelete = keys.slice(0, keys.length - maxItems + 1)
    await Promise.all(keysToDelete.map(key => cache.delete(key)))
  }
}

async function cleanupOldCaches() {
  const cacheNames = await caches.keys()
  const oldCaches = cacheNames.filter(name => 
    name !== CACHE_NAME && 
    name !== STATIC_CACHE && 
    name !== DYNAMIC_CACHE && 
    name !== API_CACHE
  )
  
  return Promise.all(oldCaches.map(name => caches.delete(name)))
}

function createOfflineResponse(request) {
  return new Response(JSON.stringify({
    error: 'Offline',
    message: 'This feature requires an internet connection',
    offline: true,
    timestamp: Date.now()
  }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json'
    }
  })
}

function createFallbackResponse(request) {
  return createOfflineResponse(request)
}

function createOfflineHtmlResponse() {
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Offline - DOPE Competition</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; padding: 20px; text-align: center; background: #000; color: #dc2626; }
        .offline-container { max-width: 400px; margin: 0 auto; }
        .offline-icon { font-size: 64px; margin-bottom: 20px; }
        button { background: #dc2626; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 16px; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="offline-container">
        <div class="offline-icon">📱</div>
        <h1>You're Offline</h1>
        <p>Check your internet connection and try again.</p>
        <button onclick="location.reload()">Retry</button>
      </div>
    </body>
    </html>
  `, {
    headers: { 'Content-Type': 'text/html' }
  })
}

async function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('DopeOfflineDB', 1)
    
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      
      // Scores store
      if (!db.objectStoreNames.contains('scores')) {
        const scoresStore = db.createObjectStore('scores', { 
          keyPath: 'id', 
          autoIncrement: true 
        })
        scoresStore.createIndex('synced', 'synced')
        scoresStore.createIndex('timestamp', 'timestamp')
      }
      
      // Timer events store
      if (!db.objectStoreNames.contains('timer_events')) {
        const eventsStore = db.createObjectStore('timer_events', { 
          keyPath: 'id', 
          autoIncrement: true 
        })
        eventsStore.createIndex('synced', 'synced')
        eventsStore.createIndex('timestamp', 'timestamp')
      }
    }
  })
}

async function queueForSync(request) {
  // Register for background sync
  try {
    await self.registration.sync.register('score-submission')
  } catch (error) {
    console.error('[SW] Background sync registration failed:', error)
  }
}

async function initializeOfflineStorage() {
  try {
    await openOfflineDB()
    console.log('[SW] Offline storage initialized')
  } catch (error) {
    console.error('[SW] Failed to initialize offline storage:', error)
  }
}

async function getOfflineData() {
  try {
    const db = await openOfflineDB()
    
    const scores = await getAllFromStore(db, 'scores')
    const timerEvents = await getAllFromStore(db, 'timer_events')
    
    return {
      scores: scores.filter(s => !s.synced),
      timerEvents: timerEvents.filter(e => !e.synced)
    }
  } catch (error) {
    console.error('[SW] Failed to get offline data:', error)
    return { scores: [], timerEvents: [] }
  }
}

async function getAllFromStore(db, storeName) {
  const transaction = db.transaction([storeName], 'readonly')
  const store = transaction.objectStore(storeName)
  
  return new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function handleNonGetRequest(event) {
  // Handle POST, PUT, DELETE requests
  const { request } = event
  
  if (isApiRequest(new URL(request.url))) {
    event.respondWith(
      fetch(request).catch(() => {
        // Queue for later sync if it's a data modification request
        if (request.method === 'POST' || request.method === 'PUT') {
          queueForSync(request)
        }
        
        return new Response(JSON.stringify({
          success: false,
          offline: true,
          queued: true
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' }
        })
      })
    )
  }
}

console.log('[SW] Mobile Service Worker loaded successfully')
