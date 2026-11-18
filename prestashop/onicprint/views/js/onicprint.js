/* Printed stock admin page (Catalog > Printed stock). Plain JS, talks JSON to AdminOnicPrintController. */
(function () {
  'use strict';
  var root, url, S = null, ui = { tab: 'items', filter: 'managed', q: '', open: {}, edit: null, changes: null, preview: null, history: null, busy: false };
  var PRIOS = [[1, 'High'], [0, 'Normal'], [-1, 'Low']];

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function key(i) { return i.productId + '-' + i.combinationId; }
  function partName(id) { for (var k = 0; k < S.parts.length; k++) if (S.parts[k].id === id) return S.parts[k].name; return 'part ' + id; }
  function stockOf(part, colour) { for (var k = 0; k < S.stock.length; k++) if (S.stock[k].partId === part && S.stock[k].colour === colour) return S.stock[k].qty; return 0; }

  function call(op, body) {
    ui.busy = true;
    return fetch(url + '&op=' + encodeURIComponent(op), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        ui.busy = false;
        if (!r.ok) throw new Error(r.error || 'Failed');
        if (r.items) S = r;
        if (r.changes && op !== 'preview') ui.changes = r.changes;
        return r;
      })
      .catch(function (e) { ui.busy = false; alert(e.message); throw e; });
  }
  function act(op, body) { return call(op, body).then(render, function () {}); }

  // ---------------------------------------------------------------- views
  function isShort(i) { return i.managed && i.buildable !== null && i.buildable < i.minQty; }
  function isOut(i) { return i.managed && i.minQty > 0 && i.buildable === 0; }   // wanted in stock, none buildable
  function pass(i) {
    var f = ui.filter;
    if (f === 'managed' && !i.managed) return false;
    if (f === 'short' && !isShort(i)) return false;
    if (f === 'out' && !isOut(i)) return false;
    if (f === 'norecipe' && !(i.managed && !i.recipe.length)) return false;
    if (ui.q && (i.reference + ' ' + i.label + ' ' + i.productName).toLowerCase().indexOf(ui.q.toLowerCase()) < 0) return false;
    return true;
  }
  function count(f) { var o = ui.filter, n; ui.filter = f; var q = ui.q; ui.q = ''; n = S.items.filter(pass).length; ui.filter = o; ui.q = q; return n; }

  function header() {
    var managed = S.items.filter(function (i) { return i.managed; });
    var out = managed.filter(isOut).length, short = managed.filter(isShort).length - out;
    return '<div class="op-top">' +
      '<div class="op-tiles">' +
      '<div class="op-tile"><b>' + managed.length + '</b><span>managed items</span></div>' +
      '<div class="op-tile ' + (out ? 'bad' : '') + '"><b>' + out + '</b><span>out of stock</span></div>' +
      '<div class="op-tile ' + (short ? 'warn' : '') + '"><b>' + short + '</b><span>below minimum</span></div>' +
      '<div class="op-tile"><b>' + S.parts.length + '</b><span>printed parts</span></div></div>' +
      '<div class="op-mode ' + (S.live ? 'live' : '') + '">' +
      '<div><b>' + (S.live ? 'Live' : 'Log only') + '</b><div class="op-dim">' + (S.live
        ? 'Store quantities follow the parts on hand automatically.'
        : 'Store quantities are worked out and logged, not written.') + '</div></div>' +
      '<button class="btn btn-default" data-a="preview">Preview store quantities</button>' +
      '<button class="btn ' + (S.live ? 'btn-default' : 'btn-primary') + '" data-a="live">' + (S.live ? 'Back to log only' : 'Go live') + '</button>' +
      '</div></div>';
  }

  function changesBox() {
    var c = ui.preview || ui.changes;
    if (!c) return '';
    var isPrev = !!ui.preview;
    var rows = c.map(function (x) { return '<tr><td><code>' + esc(x.reference) + '</code></td><td>' + esc(x.label) + '</td><td class="num">' + x.before + ' → <b>' + x.after + '</b></td></tr>'; }).join('');
    return '<div class="op-changes ' + (isPrev ? 'preview' : '') + '">' +
      '<div class="op-changes-head"><b>' + (isPrev ? 'Store quantities from the parts on hand' : (c.length ? (c[0].written ? 'Store quantities updated' : 'Store quantities that would change (log only)') : '')) + '</b>' +
      '<span class="op-dim">' + c.length + ' change' + (c.length === 1 ? '' : 's') + '</span><span class="op-sp"></span>' +
      (isPrev && c.length ? '<button class="btn btn-primary btn-sm" data-a="apply">Write these to the store</button>' : '') +
      '<button class="btn btn-default btn-sm" data-a="closechanges">Close</button></div>' +
      (c.length ? '<table class="table op-table"><thead><tr><th title="The combination reference in the store">Reference</th><th title="Product and options">Item</th><th class="num" title="Store quantity now → what the parts on hand allow">Store</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="op-dim">Every managed item already matches its parts on hand.</p>') + '</div>';
  }

  function tabs() {
    var t = [['items', 'Store items'], ['parts', 'Printed parts'], ['history', 'History']];
    return '<ul class="nav nav-tabs op-tabs">' + t.map(function (x) {
      return '<li class="' + (ui.tab === x[0] ? 'active' : '') + '"><a href="#" data-a="tab" data-v="' + x[0] + '">' + x[1] + '</a></li>';
    }).join('') + '</ul>';
  }

  function prioSelect(i) {
    return '<select class="form-control op-prio p' + i.priority + '" data-a="prio" data-k="' + key(i) + '">' +
      PRIOS.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === i.priority ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select>';
  }
  function colourCell(i) {
    if (i.hasStoreColour && !i.ignoreStoreColour) return '<span class="op-chip colour">' + esc(i.storeColour) + '</span>';
    return '<select class="form-control op-sel" data-a="printcolour" data-k="' + key(i) + '"><option value="">Any colour</option>' +
      S.colours.map(function (c) { return '<option' + (c === i.printColour ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>';
  }
  function itemRow(i) {
    var short = isShort(i), recipe = i.recipe.length
      ? i.recipe.map(function (r) { return '<span class="op-chip">' + r.qty + '× ' + esc(partName(r.partId)) + '</span>'; }).join('')
      : (i.managed ? '<span class="op-warn">No recipe</span>' : '');
    var build = i.buildable === null ? '<span class="op-dim">–</span>'
      : '<span class="op-pill ' + (i.buildable === 0 ? 'bad' : short ? 'warn' : 'good') + '">' + i.buildable + '</span>';
    var html = '<tr class="' + (i.managed ? '' : 'off') + '">' +
      '<td class="chk"><input type="checkbox" data-a="managed" data-k="' + key(i) + '"' + (i.managed ? ' checked' : '') + ' title="Keep this item in stock"></td>' +
      '<td>' + (i.options.length ? i.options.map(function (o) { return '<span class="op-chip opt">' + esc(o.value) + '</span>'; }).join('') : '<span class="op-dim">—</span>') + '</td>' +
      '<td><code>' + esc(i.reference || '—') + '</code></td>' +
      '<td class="num">' + i.storeQty + (i.managed && i.buildable !== null && i.buildable !== i.storeQty ? ' <span class="op-dim" title="Store quantity differs from the parts on hand">≠</span>' : '') + '</td>' +
      '<td class="num">' + (i.managed ? build : '') + '</td>' +
      '<td class="num">' + (i.managed ? '<input type="number" min="0" class="form-control op-num" data-a="min" data-k="' + key(i) + '" value="' + i.minQty + '">' : '') + '</td>' +
      '<td>' + (i.managed ? prioSelect(i) : '') + '</td>' +
      '<td>' + (i.managed ? colourCell(i) : '') + '</td>' +
      '<td>' + recipe + '</td>' +
      '<td class="act">' + (i.managed ? '<button class="btn btn-default btn-sm" data-a="edit" data-k="' + key(i) + '">' + (ui.edit && ui.edit.k === key(i) ? 'Close' : 'Edit recipe') + '</button>' : '') + '</td></tr>';
    if (ui.edit && ui.edit.k === key(i)) html += '<tr class="op-editor"><td></td><td colspan="9">' + recipeEditor() + '</td></tr>';
    return html;
  }
  /** Units of a part available for an item's colour (null = any colour: all of them). */
  function avail(partId, colour) {
    var n = 0;
    S.stock.forEach(function (x) { if (x.partId === partId && (colour === null || x.colour === colour)) n += Math.max(0, x.qty); });
    return n;
  }
  function recipeEditor() {
    var e = ui.edit, it = item(e.k), colour = it.colour;
    var sets = null;
    e.lines.forEach(function (l) { var n = Math.floor(avail(l.partId, colour) / Math.max(1, l.qty)); sets = sets === null ? n : Math.min(sets, n); });
    var opts = function (sel) {
      return S.parts.map(function (p) {
        var taken = p.id !== sel && e.lines.some(function (l) { return l.partId === p.id; });
        return '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + (taken ? ' disabled' : '') + '>' + esc(p.name) + (p.material ? ' (' + esc(p.material) + ')' : '') + '</option>';
      }).join('');
    };
    return '<div class="op-recipe"><table class="op-rtable"><thead><tr><th title="How many of this part go into one item">Qty</th><th></th><th title="A part printed by the 3D printers">Printed part</th><th class="num" title="Loose parts you have that this item can use (its colour, or every colour for an any-colour item)">On hand' + (colour ? ' (' + esc(colour) + ')' : '') + '</th><th></th></tr></thead><tbody>' +
      e.lines.map(function (l, n) {
        return '<tr><td><input type="number" min="1" class="form-control op-num" data-a="lqty" data-n="' + n + '" value="' + l.qty + '"></td><td class="op-dim">×</td>' +
          '<td><select class="form-control op-sel wide" data-a="lpart" data-n="' + n + '">' + opts(l.partId) + '</select></td>' +
          '<td class="num"><b>' + avail(l.partId, colour) + '</b></td>' +
          '<td><button class="btn btn-link op-x" data-a="ldel" data-n="' + n + '" title="Remove this part">✕</button></td></tr>';
      }).join('') + '</tbody></table>' +
      (e.lines.length ? '' : '<div class="op-dim">No recipe yet: add the printed parts one item is made of.</div>') +
      '<div class="op-rfoot"><button class="btn btn-default btn-sm" data-a="ladd"' + (e.lines.length < S.parts.length ? '' : ' disabled') + '>+ Add a part</button>' +
      '<span class="op-rbuild' + (sets === 0 ? ' zero' : '') + '">' + (sets === null ? '' : 'Can build <b>' + sets + '</b> set' + (sets === 1 ? '' : 's') + ' from the parts on hand') + '</span>' +
      '<span class="op-sp"></span><button class="btn btn-default btn-sm" data-a="edit" data-k="' + e.k + '">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" data-a="lsave">Save recipe</button></div></div>';
  }

  function itemsTab() {
    var F = [['managed', 'Managed'], ['out', 'Out of stock'], ['short', 'Below minimum'], ['norecipe', 'No recipe'], ['all', 'All']];
    var shown = S.items.filter(pass), groups = [], seen = {};
    shown.forEach(function (i) { if (!seen[i.productId]) { seen[i.productId] = 1; groups.push(i.productId); } });
    var html = '<div class="op-bar"><input class="form-control op-search" placeholder="Search name or reference…" data-a="search" value="' + esc(ui.q) + '">' +
      '<div class="btn-group">' + F.map(function (f) { return '<button class="btn btn-default' + (ui.filter === f[0] ? ' active' : '') + '" data-a="filter" data-v="' + f[0] + '">' + f[1] + ' <span class="op-dim">' + count(f[0]) + '</span></button>'; }).join('') + '</div></div>' +
      '<p class="op-dim">Tick the items to keep in stock, give each a minimum and a recipe (the printed parts one item is made of). <b>Can build</b> = full sets from the parts on hand; that becomes the store quantity.</p>';
    groups.forEach(function (pid) {
      var all = S.items.filter(function (i) { return i.productId === pid; }), rows = shown.filter(function (i) { return i.productId === pid; });
      var open = ui.open[pid] || ui.q || ui.filter !== 'managed' || rows.length <= 4;
      var man = all.filter(function (i) { return i.managed; }).length, sh = all.filter(isShort).length, out = all.filter(isOut).length;
      html += '<div class="op-product"><div class="op-phead" data-a="toggle" data-v="' + pid + '"><span class="op-caret">' + (open ? '▾' : '▸') + '</span><b>' + esc(all[0].productName) + '</b>' +
        '<span class="op-pill">' + all.length + ' item' + (all.length === 1 ? '' : 's') + '</span>' + (man ? '<span class="op-pill blue">' + man + ' managed</span>' : '') +
        (out ? '<span class="op-pill bad">' + out + ' out</span>' : '') + (sh - out > 0 ? '<span class="op-pill warn">' + (sh - out) + ' below min</span>' : '') + '<span class="op-sp"></span>' +
        (all[0].hasStoreColour ? '<label class="op-inline" data-stop="1"><input type="checkbox" data-a="ignorecolour" data-v="' + pid + '"' + (all[0].ignoreStoreColour ? '' : ' checked') + '> Print in the store colour</label>' : '') +
        (all.length > 1 ? '<button class="btn btn-link btn-sm" data-a="all" data-v="' + pid + '" data-on="1">Manage all</button><button class="btn btn-link btn-sm" data-a="all" data-v="' + pid + '" data-on="0">None</button>' : '') + '</div>';
      if (open) html += '<table class="table op-table"><thead><tr><th title="Ticked = kept in stock with printed parts (the printers fill it up to its minimum)">✓</th><th title="The store combination (size, colour, ...)">Options</th><th title="The combination reference in the store">Reference</th><th class="num" title="Quantity the store shows now. ≠ means it differs from what the parts on hand allow (written when Printed stock is live)">Store</th><th class="num" title="Full sets the printed parts on hand allow. This becomes the store quantity">Can build</th><th class="num" title="Minimum to keep in stock; the printers fill up to this">Min</th><th title="Print order: High first, then out-of-stock items, then the rest up to their minimum">Priority</th><th title="The colour it is printed in: the store colour option, or the "print in" choice when the product has none (or ignores it)">Colour</th><th title="The printed parts that make one item">Recipe</th><th></th></tr></thead><tbody>' +
        rows.map(itemRow).join('') + '</tbody></table>';
      html += '</div>';
    });
    if (!groups.length) html += '<p class="op-dim">Nothing matches.</p>';
    return html;
  }

  /**
   * Parts still to print so every managed item can reach its minimum. Per part and colour the
   * target is the most any one item needs (qty per set x minimum): a part shared by several items
   * counts for each of them, as the store shows it. Parts on hand count against it; "any colour"
   * items may use every colour. Same rule as the printer controller's queue (which also counts
   * plates already printing).
   */
  function toPrint() {
    var target = {};   // partId -> { colour|'*': units }
    S.items.forEach(function (i) {
      if (!i.managed || !i.minQty) return;
      i.recipe.forEach(function (r) {
        var t = target[r.partId] = target[r.partId] || {}, c = i.colour === null ? '*' : i.colour;
        t[c] = Math.max(t[c] || 0, r.qty * i.minQty);
      });
    });
    var out = {};
    Object.keys(target).forEach(function (pid) {
      var t = target[pid], res = [], coloured = 0;
      // Coloured needs first; parts printed for them also serve the "any colour" items.
      Object.keys(t).forEach(function (c) {
        if (c === '*') return;
        var n = t[c] - avail(+pid, c);
        if (n > 0) { res.push({ colour: c, n: n }); coloured += n; }
      });
      if (t['*']) { var any = t['*'] - avail(+pid, null) - coloured; if (any > 0) res.push({ colour: '', n: any }); }
      out[pid] = res;
    });
    return out;
  }

  function partsTab() {
    var cols = [''].concat(S.colours);
    var used = {}, need = toPrint();
    S.items.forEach(function (i) { if (i.managed) i.recipe.forEach(function (r) { (used[r.partId] = used[r.partId] || []).push(i.reference || i.label); }); });
    var head = '<tr><th title="Printed part name (also used by the printer controller for its G-code files)">Part</th><th title="Filament it is printed in (ABS, PLA, ...)">Material</th>' + cols.map(function (c) { return '<th class="num" title="' + (c ? 'Loose parts on hand in ' + esc(c) : 'Loose parts on hand with no colour (counted for any-colour items)') + '">' + esc(c || 'No colour') + '</th>'; }).join('') +
      '<th class="num" title="All colours together">Total on hand</th><th class="num" title="Managed store items whose recipe uses this part">Used in</th>' +
      '<th title="Still to print so every managed item can reach its minimum">To print</th><th></th></tr>';
    var rows = S.parts.map(function (p) {
      var total = 0, u = used[p.id] || [], n = need[p.id] || [];   // need[p.id] undefined = no item using it has a minimum
      var cells = cols.map(function (c) { var q = stockOf(p.id, c); total += q; return '<td class="num"><input type="number" min="0" class="form-control op-num' + (q < 0 ? ' neg' : '') + '" data-a="stock" data-v="' + p.id + '" data-c="' + esc(c) + '" value="' + q + '"></td>'; }).join('');
      return '<tr><td><input class="form-control" data-a="pname" data-v="' + p.id + '" value="' + esc(p.name) + '"></td>' +
        '<td><input class="form-control op-mat" data-a="pmat" data-v="' + p.id + '" value="' + esc(p.material) + '"></td>' + cells +
        '<td class="num"><b>' + total + '</b></td>' +
        '<td class="num" title="' + esc(u.join('\n')) + '">' + (u.length ? u.length + ' item' + (u.length === 1 ? '' : 's') : '<span class="op-dim">none</span>') + '</td>' +
        '<td>' + (n.length ? n.map(function (x) { return '<span class="op-pill warn">' + x.n + ' ' + esc(x.colour || 'any colour') + '</span>'; }).join(' ')
          : need[p.id] ? '<span class="op-pill good">enough</span>' : u.length ? '<span class="op-dim" title="Every item using it has a minimum of 0">no minimums</span>' : '') + '</td>' +
        '<td class="act"><button class="btn btn-link" data-a="pdel" data-v="' + p.id + '" title="Delete part">✕</button></td></tr>';
    }).join('');
    return '<div class="op-bar"><input class="form-control" id="op-newname" placeholder="New part name"><input class="form-control op-mat" id="op-newmat" placeholder="Material">' +
      '<button class="btn btn-primary" data-a="padd">Add part</button></div>' +
      '<p class="op-dim">On hand = loose printed parts you actually have, per colour; change a number after a physical count (printed parts from the controller and sales update it on their own). ' +
      '<b>To print</b> = what is still missing for every managed item to reach its minimum; a part shared by several items counts once per colour, as the store shows stock. Plates already printing are not counted here (the controller\'s queue does count them).</p>' +
      '<div class="op-scroll"><table class="table op-table op-parts"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
  }

  function historyTab() {
    var h = ui.history;
    if (!h) { call('history').then(function (r) { ui.history = r; render(); }, function () {}); return '<p class="op-dim">Loading…</p>'; }
    var label = { print: 'Printed', sale: 'Sold', 'return': 'Order cancelled', count: 'Counted', 'import': 'Imported' };
    return '<h4>Parts on hand changes</h4><div class="op-scroll"><table class="table op-table"><thead><tr><th title="Store time">When</th><th title="Printed part">Part</th><th title="Colour of the parts that changed">Colour</th><th class="num" title="Parts added (+) or taken (−)">Change</th><th title="Printed (from the controller), Sold, Order cancelled, Counted (by hand) or Imported">Why</th><th title="Order reference, printer and job, or who counted">Note</th></tr></thead><tbody>' +
      h.moves.map(function (m) { return '<tr><td class="op-dim">' + esc(m.date_add) + '</td><td>' + esc(m.part || m.id_part) + '</td><td>' + esc(m.colour || '—') + '</td><td class="num ' + (m.delta < 0 ? 'neg' : 'pos') + '">' + (m.delta > 0 ? '+' : '') + m.delta + '</td><td>' + esc(label[m.reason] || m.reason) + '</td><td class="op-dim">' + esc(m.note) + '</td></tr>'; }).join('') +
      '</tbody></table></div><h4>Store quantity changes</h4><div class="op-scroll"><table class="table op-table"><thead><tr><th title="Store time">When</th><th title="The combination reference">Reference</th><th class="num" title="Store quantity before → after">Store</th><th title="Yes = written to the store; log only = worked out but not written (log-only mode)">Written</th><th title="What changed: an order, printed parts, a count, a recipe ...">Why</th></tr></thead><tbody>' +
      h.quantities.map(function (q) { return '<tr><td class="op-dim">' + esc(q.date_add) + '</td><td><code>' + esc(q.reference) + '</code></td><td class="num">' + q.qty_before + ' → <b>' + q.qty_after + '</b></td><td>' + (+q.written ? 'Yes' : '<span class="op-dim">log only</span>') + '</td><td class="op-dim">' + esc(q.reason) + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }

  function render() {
    if (!S) return;
    var focus = document.activeElement && document.activeElement.getAttribute('data-a') === 'search';
    root.innerHTML = header() + changesBox() + tabs() + '<div class="op-body">' +
      (ui.tab === 'items' ? itemsTab() : ui.tab === 'parts' ? partsTab() : historyTab()) + '</div>';
    if (focus) { var s = root.querySelector('[data-a=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }

  // ---------------------------------------------------------------- events
  function item(k) { for (var n = 0; n < S.items.length; n++) if (key(S.items[n]) === k) return S.items[n]; }
  function ids(k) { var p = k.split('-'); return { productId: +p[0], combinationId: +p[1] }; }
  function merge(a, b) { for (var x in b) a[x] = b[x]; return a; }

  function onClick(e) {
    var t = e.target.closest('[data-a]');
    if (!t || !root.contains(t)) return;
    var a = t.getAttribute('data-a'), v = t.getAttribute('data-v'), k = t.getAttribute('data-k'), n = +t.getAttribute('data-n');
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT') return;   // handled on change
    if (a === 'toggle') { if (e.target.closest('[data-stop]') || e.target.closest('button')) return; ui.open[v] = !ui.open[v]; render(); return; }
    e.preventDefault();
    if (a === 'tab') { ui.tab = v; if (v === 'history') ui.history = null; render(); }
    else if (a === 'filter') { ui.filter = v; render(); }
    else if (a === 'all') {
      var on = t.getAttribute('data-on') === '1', list = S.items.filter(function (i) { return i.productId === +v && i.managed !== on; });
      list.reduce(function (p, i) { return p.then(function () { return call('saveItem', merge(ids(key(i)), { managed: on })); }); }, Promise.resolve()).then(render, render);
    }
    else if (a === 'edit') {
      if (ui.edit && ui.edit.k === k) ui.edit = null;
      else ui.edit = { k: k, lines: item(k).recipe.map(function (r) { return { partId: r.partId, qty: r.qty }; }) };
      render();
    }
    else if (a === 'ladd') {
      var free = S.parts.filter(function (p) { return !ui.edit.lines.some(function (l) { return l.partId === p.id; }); })[0];
      if (free) { ui.edit.lines.push({ partId: free.id, qty: 1 }); render(); }
    }
    else if (a === 'ldel') { ui.edit.lines.splice(n, 1); render(); }
    else if (a === 'lsave') { var k2 = ui.edit.k, lines = ui.edit.lines; ui.edit = null; act('saveRecipe', merge(ids(k2), { lines: lines })); }
    else if (a === 'preview') { call('preview').then(function (r) { ui.preview = r.changes; ui.changes = null; render(); }, function () {}); }
    else if (a === 'apply') {
      if (!confirm('Write ' + ui.preview.length + ' store quantit' + (ui.preview.length === 1 ? 'y' : 'ies') + ' now?')) return;
      ui.preview = null; act('apply');
    }
    else if (a === 'closechanges') { ui.preview = null; ui.changes = null; render(); }
    else if (a === 'live') {
      var goLive = !S.live;
      if (!confirm(goLive ? 'Go live? From now on every change to parts on hand, recipes or orders sets the store quantities of managed items.' : 'Back to log only? Store quantities stop being written.')) return;
      act('setLive', { live: goLive });
    }
    else if (a === 'padd') {
      var nm = document.getElementById('op-newname').value, mt = document.getElementById('op-newmat').value;
      act('savePart', { name: nm, material: mt });
    }
    else if (a === 'pdel') { var p = S.parts.filter(function (x) { return x.id === +v; })[0]; if (confirm('Delete the part "' + p.name + '"?')) act('deletePart', { id: +v }); }
  }

  function onChange(e) {
    var t = e.target, a = t.getAttribute('data-a');
    if (!a) return;
    var k = t.getAttribute('data-k'), v = t.getAttribute('data-v'), n = +t.getAttribute('data-n');
    if (a === 'managed') act('saveItem', merge(ids(k), { managed: t.checked }));
    else if (a === 'min') act('saveItem', merge(ids(k), { minQty: +t.value || 0 }));
    else if (a === 'prio') act('saveItem', merge(ids(k), { priority: +t.value }));
    else if (a === 'printcolour') act('saveItem', merge(ids(k), { printColour: t.value }));
    else if (a === 'ignorecolour') act('saveProduct', { productId: +v, ignoreStoreColour: !t.checked });
    else if (a === 'lqty') { ui.edit.lines[n].qty = Math.max(1, +t.value || 1); render(); }
    else if (a === 'lpart') { ui.edit.lines[n].partId = +t.value; render(); }
    else if (a === 'stock') act('setStock', { partId: +v, colour: t.getAttribute('data-c'), qty: Math.max(0, +t.value || 0) });
    else if (a === 'pname' || a === 'pmat') {
      var p = S.parts.filter(function (x) { return x.id === +v; })[0];
      act('savePart', { id: p.id, name: a === 'pname' ? t.value : p.name, material: a === 'pmat' ? t.value : p.material, notes: p.notes });
    }
  }
  function onInput(e) { if (e.target.getAttribute('data-a') === 'search') { ui.q = e.target.value; render(); } }

  document.addEventListener('DOMContentLoaded', function () {
    root = document.getElementById('onicprint-app');
    if (!root) return;
    url = root.getAttribute('data-url');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    call('state').then(render, function () { root.innerHTML = '<p class="alert alert-danger">Could not load the printed stock.</p>'; });
  });
})();
