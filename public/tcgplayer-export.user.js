// ==UserScript==
// @name         TCGPlayer Export for Reseller Dashboard
// @namespace    https://sellerportal.tcgplayer.com
// @version      2.5
// @description  Export orders matching the current portal filter for Reseller Dashboard import
// @match        https://sellerportal.tcgplayer.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict'

  const PAGE_SIZE = 100
  const BASE = 'https://order-management-api.tcgplayer.com'

  const RANGE_LABEL = {
    LastMonth: 'Last month',
    LastThreeMonths: 'Last 3 months',
    LastFourMonths: 'Last 4 months',
    LastSixMonths: 'Last 6 months',
    LastYear: 'Last year',
    LastTwoYears: 'Last 2 years',
  }

  let capturedHeaders = null
  let capturedSellerKey = null

  function onCaptured(headers, bodyStr) {
    capturedHeaders = headers
    if (typeof bodyStr === 'string') {
      try {
        const parsed = JSON.parse(bodyStr)
        if (parsed.filters?.sellerKey) capturedSellerKey = parsed.filters.sellerKey
      } catch {}
    }
    updateButton()
  }

  // ── Intercept window.fetch (runs before portal JS since @run-at document-start)

  const origFetch = window.fetch.bind(window)
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input
      : (input instanceof Request ? input.url : String(input))
    if (url.includes('order-management-api.tcgplayer.com') && init?.headers) {
      const h = init.headers
      const headers = {}
      if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v })
      else Object.assign(headers, h)
      onCaptured(headers, init.body)
    }
    return origFetch(input, init)
  }

  // ── Intercept XMLHttpRequest (Axios uses XHR by default) ─────────────────────

  const origOpen = XMLHttpRequest.prototype.open
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader
  const origSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._rdbUrl = url
    this._rdbHeaders = {}
    return origOpen.apply(this, [method, url, ...rest])
  }

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._rdbUrl?.includes('order-management-api.tcgplayer.com')) {
      this._rdbHeaders[name] = value
    }
    return origSetHeader.apply(this, [name, value])
  }

  XMLHttpRequest.prototype.send = function (body) {
    if (this._rdbUrl?.includes('order-management-api.tcgplayer.com') &&
        Object.keys(this._rdbHeaders || {}).length > 0) {
      onCaptured({ ...this._rdbHeaders }, body)
    }
    return origSend.apply(this, [body])
  }

  // ── API helpers ─────────────────────────────────────────────────────────────

  async function fetchAllOrders(searchRange, sortBy, sellerKey) {
    const orders = []
    let from = 0
    let total = Infinity
    while (from < total) {
      const res = await origFetch(`${BASE}/orders/search?api-version=2.0`, {
        method: 'POST',
        credentials: 'include',
        headers: capturedHeaders,
        body: JSON.stringify({ searchRange, filters: { sellerKey }, sortBy, from, size: PAGE_SIZE }),
      })
      if (!res.ok) throw new Error(`Search failed: ${res.status}`)
      const data = await res.json()
      total = data.totalOrders ?? 0
      orders.push(...(data.orders ?? []))
      from += PAGE_SIZE
    }
    return orders
  }

  async function fetchOrderDetail(orderNumber) {
    const res = await origFetch(`${BASE}/orders/${orderNumber}?api-version=2.0`, {
      credentials: 'include',
      headers: capturedHeaders,
    })
    if (!res.ok) throw new Error(`Detail fetch failed for ${orderNumber}: ${res.status}`)
    return res.json()
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ── Read current filter from URL ────────────────────────────────────────────

  function getExportParams() {
    const params = new URLSearchParams(window.location.search)
    const searchRange = params.get('searchRange') || 'LastThreeMonths'
    const sortByRaw = params.getAll('sortBy')
    const sortBy = sortByRaw.length > 0
      ? sortByRaw.map(s => {
          const [field, dir] = s.split(',')
          return { sortingType: field, direction: dir === 'desc' ? 'descending' : 'ascending' }
        })
      : [{ sortingType: 'orderDate', direction: 'ascending' }]
    return { searchRange, sortBy }
  }

  // ── Export flow ─────────────────────────────────────────────────────────────

  async function exportOrders() {
    if (!window.location.pathname.startsWith('/orders')) {
      alert('Navigate to the Orders page first, then click Export.')
      return
    }
    if (!capturedHeaders || !capturedSellerKey) {
      alert('Orders not loaded yet — wait for the page to finish loading, then try again.')
      return
    }

    const { searchRange, sortBy } = getExportParams()
    const btn = document.getElementById('rdb-tcg-export')
    btn.textContent = 'Fetching orders…'
    btn.disabled = true

    try {
      const orders = await fetchAllOrders(searchRange, sortBy, capturedSellerKey)
      const enriched = []

      for (let i = 0; i < orders.length; i++) {
        btn.textContent = `Fetching ${i + 1} of ${orders.length}…`
        if (!orders[i].orderNumber) continue
        const detail = await fetchOrderDetail(orders[i].orderNumber)
        enriched.push({
          orderNumber: detail.orderNumber,
          orderDate: detail.createdAt ?? orders[i].orderDate,
          orderStatus: detail.status,
          productAmount: detail.transaction?.productAmount ?? 0,
          shippingAmount: detail.transaction?.shippingAmount ?? 0,
          grossAmount: detail.transaction?.grossAmount ?? 0,
          feeAmount: detail.transaction?.feeAmount ?? 0,
          netAmount: detail.transaction?.netAmount ?? 0,
          refundStatus: detail.refundStatus ?? '',
          refunds: detail.refunds ?? [],
        })
        if ((i + 1) % 3 === 0) await sleep(1000)
      }

      const filename = `tcgplayer-orders-${new Date().toISOString().slice(0, 10)}.json`
      const blob = new Blob([JSON.stringify(enriched, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      btn.textContent = `✓ Exported ${enriched.length} orders`
    } catch (err) {
      btn.textContent = 'Export failed — see console'
      console.error('[RDB TCGPlayer Export]', err)
    } finally {
      btn.disabled = false
    }
  }

  // ── Button label ─────────────────────────────────────────────────────────────

  function getButtonLabel() {
    if (!window.location.pathname.startsWith('/orders')) return 'Export for Reseller Dashboard'
    if (!capturedHeaders) return 'Export ↓ (loading…)'
    const range = new URLSearchParams(window.location.search).get('searchRange')
    return range ? `Export (${RANGE_LABEL[range] ?? range}) ↓` : 'Export for Reseller Dashboard'
  }

  function updateButton() {
    const btn = document.getElementById('rdb-tcg-export')
    if (btn && !btn.disabled) btn.textContent = getButtonLabel()
  }

  // ── UI injection (deferred — document.body doesn't exist at document-start) ──

  function injectButton() {
    if (document.getElementById('rdb-tcg-export')) { updateButton(); return }
    if (!document.body) return
    const btn = document.createElement('button')
    btn.id = 'rdb-tcg-export'
    btn.textContent = getButtonLabel()
    btn.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:9999',
      'background:#2563eb', 'color:#fff', 'border:none', 'border-radius:6px',
      'padding:10px 16px', 'font-size:14px', 'font-weight:500', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
    ].join(';')
    btn.addEventListener('click', exportOrders)
    document.body.appendChild(btn)
  }

  // SPA URL change detection
  const origPushState = history.pushState
  history.pushState = function (...args) {
    origPushState.apply(this, args)
    setTimeout(updateButton, 50)
  }
  window.addEventListener('popstate', () => setTimeout(updateButton, 50))

  window.addEventListener('load', injectButton)
  document.addEventListener('DOMContentLoaded', () => {
    injectButton()
    new MutationObserver(() => {
      if (!document.getElementById('rdb-tcg-export')) injectButton()
    }).observe(document.body, { childList: true, subtree: true })
  })
})()
