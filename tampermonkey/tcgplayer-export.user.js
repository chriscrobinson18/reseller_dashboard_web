// ==UserScript==
// @name         TCGPlayer Export for Reseller Dashboard
// @namespace    https://seller.tcgplayer.com
// @version      1.0
// @description  Export TCGPlayer orders with fee data for Reseller Dashboard import
// @match        https://seller.tcgplayer.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  // Your seller key: lowercase prefix of any order number.
  // e.g. order "AE18D02E-28AA51-BAA99" → seller key is "ae18d02e"
  const SELLER_KEY = 'REPLACE_WITH_YOUR_SELLER_KEY'

  const PAGE_SIZE = 100
  const BASE = 'https://order-management-api.tcgplayer.com'

  // ── API helpers ─────────────────────────────────────────────────────────────

  async function fetchAllOrders(searchRange) {
    const orders = []
    let from = 0
    let total = Infinity
    while (from < total) {
      const res = await fetch(`${BASE}/orders/search?api-version=2.0`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchRange,
          filters: { sellerKey: SELLER_KEY },
          sortBy: [{ sortingType: 'orderDate', direction: 'ascending' }],
          from,
          size: PAGE_SIZE,
        }),
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
    const res = await fetch(`${BASE}/orders/${orderNumber}?api-version=2.0`, {
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`Detail fetch failed for ${orderNumber}: ${res.status}`)
    return res.json()
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ── Export flow ─────────────────────────────────────────────────────────────

  async function exportOrders() {
    if (SELLER_KEY === 'REPLACE_WITH_YOUR_SELLER_KEY') {
      alert('TCGPlayer Export: Edit the script and replace REPLACE_WITH_YOUR_SELLER_KEY with your seller key (lowercase prefix of any order number, e.g. "ae18d02e").')
      return
    }
    const choice = prompt(
      'Export date range:\n1 = Last 3 months\n2 = Last 6 months\n3 = Last year',
      '1'
    )
    if (choice === null) return // user cancelled
    const rangeMap = { '1': 'LastThreeMonths', '2': 'LastSixMonths', '3': 'LastYear' }
    const searchRange = rangeMap[choice] ?? 'LastThreeMonths'

    const btn = document.getElementById('rdb-tcg-export')
    btn.textContent = 'Fetching order list…'
    btn.disabled = true

    try {
      const orders = await fetchAllOrders(searchRange)
      const enriched = []

      for (let i = 0; i < orders.length; i++) {
        btn.textContent = `Fetching order ${i + 1} of ${orders.length}…`
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
        // ~3 req/sec throttle
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

  // ── UI injection ─────────────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById('rdb-tcg-export')) return
    const btn = document.createElement('button')
    btn.id = 'rdb-tcg-export'
    btn.textContent = 'Export for Reseller Dashboard'
    btn.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:9999',
      'background:#2563eb', 'color:#fff', 'border:none', 'border-radius:6px',
      'padding:10px 16px', 'font-size:14px', 'font-weight:500', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
    ].join(';')
    btn.addEventListener('click', exportOrders)
    document.body.appendChild(btn)
  }

  window.addEventListener('load', injectButton)
  // Re-inject after SPA navigation
  new MutationObserver(() => {
    if (!document.getElementById('rdb-tcg-export')) injectButton()
  }).observe(document.body, { childList: true, subtree: true })
})()
