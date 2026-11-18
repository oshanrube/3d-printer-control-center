{* Recipe editor inside Catalog > Product > Combinations > Edit. Writes JSON into the hidden "recipe" field. *}
<div class="onicprint-recipe" data-input="{$input_id|escape:'html':'UTF-8'}" data-parts="{$parts_json|escape:'html':'UTF-8'}" data-recipe="{$recipe_json|escape:'html':'UTF-8'}">
  <table class="opr-table"><thead><tr><th class="opr-q">Qty</th><th></th><th>Printed part</th><th class="opr-h">On hand{if $colour} ({$colour|escape:'html':'UTF-8'}){/if}</th><th></th></tr></thead><tbody></tbody></table>
  <div class="opr-empty">No recipe yet: add the printed parts one item is made of.</div>
  <div class="opr-foot"><button type="button" class="btn btn-outline-secondary btn-sm opr-add">+ Add a part</button><span class="opr-build"></span></div>
</div>
<style>
.onicprint-recipe { border: 1px solid #dbe6e9; border-radius: 6px; padding: 8px 10px; background: #fafbfc; max-width: 640px; }
.onicprint-recipe .opr-table { width: 100%; border-collapse: collapse; }
.onicprint-recipe .opr-table th { font-size: 11px; text-transform: uppercase; color: #6c868e; font-weight: 600; padding: 2px 6px 6px; text-align: left; }
.onicprint-recipe .opr-table td { padding: 3px 6px; vertical-align: middle; }
.onicprint-recipe .opr-q { width: 80px; }
.onicprint-recipe .opr-h { width: 130px; text-align: right !important; }
.onicprint-recipe td.opr-h { text-align: right; color: #6c868e; font-size: 13px; white-space: nowrap; }
.onicprint-recipe td.opr-h b { color: #363a41; }
.onicprint-recipe input.opr-qty { width: 70px; text-align: right; }
.onicprint-recipe td.opr-x { width: 30px; text-align: center; color: #6c868e; }
.onicprint-recipe .opr-del { border: none; background: none; color: #c0392b; font-size: 16px; line-height: 1; cursor: pointer; padding: 4px 6px; }
.onicprint-recipe .opr-empty { color: #6c868e; font-size: 13px; padding: 4px 6px; }
.onicprint-recipe .opr-foot { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 8px 6px 2px; border-top: 1px dashed #dbe6e9; margin-top: 6px; }
.onicprint-recipe .opr-build { font-size: 13px; color: #363a41; }
.onicprint-recipe .opr-build b { font-size: 15px; }
.onicprint-recipe .opr-build.zero b { color: #c0392b; }
</style>
<script>
(function () {
  var box = document.currentScript.previousElementSibling.previousElementSibling;
  var input = document.getElementById(box.getAttribute('data-input'));
  var parts = JSON.parse(box.getAttribute('data-parts')), rows = JSON.parse(box.getAttribute('data-recipe'));
  var tbody = box.querySelector('tbody'), empty = box.querySelector('.opr-empty'), build = box.querySelector('.opr-build');
  function part(id) { for (var i = 0; i < parts.length; i++) if (parts[i].id === id) return parts[i]; return null; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function save() {
    input.value = JSON.stringify(rows.filter(function (r) { return r.partId && r.qty > 0; }));
    var sets = null;
    rows.forEach(function (r) { var p = part(r.partId); if (!p || !(r.qty > 0)) return; var n = Math.floor(Math.max(0, p.onHand) / r.qty); sets = sets === null ? n : Math.min(sets, n); });
    build.className = 'opr-build' + (sets === 0 ? ' zero' : '');
    build.innerHTML = sets === null ? '' : 'Can build <b>' + sets + '</b> set' + (sets === 1 ? '' : 's') + ' from the parts on hand';
  }
  function render() {
    tbody.innerHTML = rows.map(function (r, n) {
      var p = part(r.partId);
      return '<tr><td><input type="number" min="1" class="form-control opr-qty" data-n="' + n + '" value="' + r.qty + '"></td><td class="opr-x">×</td>' +
        '<td><select class="custom-select form-control opr-part" data-n="' + n + '">' + parts.map(function (o) {
          var taken = o.id !== r.partId && rows.some(function (x) { return x.partId === o.id; });
          return '<option value="' + o.id + '"' + (o.id === r.partId ? ' selected' : '') + (taken ? ' disabled' : '') + '>' + esc(o.name + (o.material ? ' (' + o.material + ')' : '')) + '</option>';
        }).join('') + '</select></td>' +
        '<td class="opr-h"><b>' + (p ? p.onHand : 0) + '</b></td>' +
        '<td><button type="button" class="opr-del" data-n="' + n + '" title="Remove this part">✕</button></td></tr>';
    }).join('');
    empty.style.display = rows.length ? 'none' : '';
    box.querySelector('.opr-add').disabled = rows.length >= parts.length;
    save();
  }
  box.addEventListener('input', function (e) { if (e.target.classList.contains('opr-qty')) { rows[+e.target.getAttribute('data-n')].qty = Math.max(1, parseInt(e.target.value, 10) || 1); save(); } });
  box.addEventListener('change', function (e) { if (e.target.classList.contains('opr-part')) { rows[+e.target.getAttribute('data-n')].partId = +e.target.value; render(); } });
  box.addEventListener('click', function (e) {
    var t = e.target;
    if (t.classList.contains('opr-del')) { rows.splice(+t.getAttribute('data-n'), 1); render(); }
    else if (t.classList.contains('opr-add')) {
      var free = parts.filter(function (o) { return !rows.some(function (x) { return x.partId === o.id; }); })[0];
      if (free) { rows.push({ partId: free.id, qty: 1 }); render(); var s = tbody.querySelectorAll('.opr-part'); s[s.length - 1].focus(); }
    }
  });
  render();
})();
</script>
