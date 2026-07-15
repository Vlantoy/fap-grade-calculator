/**
 * FAP Grade MVP — Console one-shot
 * Chỉ tính điểm trung bình CÓ TRỌNG SỐ của 1 môn đang mở.
 * Tự reset sau TTL_MS (mặc định 3 phút) — như chưa từng tính.
 *
 * Cách dùng:
 * 1. Mở FAP → Mark Report → chọn 1 môn (StudentGrade.aspx?course=...)
 * 2. F12 → Console
 * 3. Dán toàn bộ file này → Enter
 * 4. Gõ điểm vào ô Value → Average tự cập nhật
 * 5. Hết 3 phút / F5 = mất
 *
 * Không GPA kỳ, không session, không overlay.
 */
(function fapGradeMVP() {
  'use strict';

  var TTL_MS = 3 * 60 * 1000; // 3 phút
  var WEIGHT_RE = /(\d+(?:[.,]\d+)?)\s*[%％]/;
  var RESIT_RE = /\bresit\b|thi\s*lại|thi\s*lai|retake|học\s*lại|hoc\s*lai/i;

  function text(el) {
    if (!el) return '';
    var inp = el.querySelector && el.querySelector('input[data-fap-mvp]');
    if (inp) return String(inp.value || '').trim();
    return ((el.innerText || el.textContent) || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseWeight(s) {
    var m = String(s || '').match(WEIGHT_RE);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }

  function parseScore(s) {
    s = String(s || '').replace(/\u00a0/g, ' ').trim().replace(',', '.');
    if (!s || s === '-' || s === '—') return null;
    if (WEIGHT_RE.test(s) && s.length <= 12) return null;
    var m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function isAvgRow(tr) {
    return /average|trung\s*b[iì]nh|điểm\s*trung|course\s*total|tổng\s*kết/i.test(text(tr));
  }

  function isTotalLabel(s) {
    return /^total$/i.test(String(s || '').trim());
  }

  function isResit(name) {
    return RESIT_RE.test(name || '');
  }

  function baseKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(RESIT_RE, ' ')
      .replace(/[:\-_|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function clamp(v) {
    if (v == null || !isFinite(v)) return 0;
    return Math.min(10, Math.max(0, v));
  }

  // Gỡ overlay watcher nếu còn
  var ov = document.getElementById('__fap_overlay__');
  if (ov) ov.remove();

  var root =
    document.getElementById('ctl00_mainContent_divGrade') ||
    document.querySelector('[id$="divGrade"]');
  var table =
    (root && (root.querySelector('table[summary="Report"]') || root.querySelector('table'))) ||
    document.querySelector('table[summary="Report"]');

  if (!table || !table.rows) {
    console.error('[FAP MVP] Không thấy bảng điểm. Mở đúng trang 1 môn (StudentGrade + course=).');
    return;
  }

  var components = [];
  var avgTd = null;
  var snapshots = [];
  var avgSnap = null;
  var expiresAt = Date.now() + TTL_MS;
  var dead = false;

  for (var r = 0; r < table.rows.length; r++) {
    var tr = table.rows[r];
    var cells = tr.cells;
    if (!cells || !cells.length) continue;

    if (isAvgRow(tr)) {
      for (var a = 0; a < cells.length; a++) {
        if (parseWeight(text(cells[a])) != null) continue;
        if (parseScore(text(cells[a])) != null) {
          avgTd = cells[a];
          break;
        }
      }
      if (!avgTd) avgTd = cells[cells.length - 1];
      continue;
    }

    for (var c = 0; c < cells.length; c++) {
      var wt = text(cells[c]);
      var w = parseWeight(wt);
      if (w == null || w <= 0 || w > 100 || wt.length > 14) continue;

      var name = c > 0 ? text(cells[c - 1]) : '';
      if (isTotalLabel(name)) continue;

      var valTd = cells[c + 1];
      if (!valTd || parseWeight(text(valTd)) != null) continue;

      var existing = parseScore(text(valTd));
      var inp = valTd.querySelector('input[data-fap-mvp]');
      if (!inp) {
        snapshots.push({ el: valTd, html: valTd.innerHTML });
        valTd.textContent = '';
        inp = document.createElement('input');
        inp.type = 'text';
        inp.setAttribute('data-fap-mvp', '1');
        inp.value = existing != null ? String(existing) : '';
        inp.placeholder = '0';
        inp.size = 5;
        inp.style.cssText = 'width:52px;height:22px';
        valTd.appendChild(inp);
      }

      components.push({
        name: name,
        weight: w,
        input: inp,
        resit: isResit(name),
        key: baseKey(name),
      });
    }
  }

  if (!components.length) {
    console.error('[FAP MVP] 0 thành phần weight. Kiểm tra bảng Report.');
    return;
  }

  function readVal(inp) {
    var raw = String(inp.value || '').trim();
    if (raw === '') return null;
    var v = parseScore(raw);
    return v == null ? null : clamp(v);
  }

  function teardown() {
    if (dead) return;
    dead = true;
    var i;
    for (i = 0; i < snapshots.length; i++) {
      if (snapshots[i].el && snapshots[i].el.isConnected) {
        snapshots[i].el.innerHTML = snapshots[i].html;
      }
    }
    if (avgSnap && avgSnap.el && avgSnap.el.isConnected) {
      avgSnap.el.innerHTML = avgSnap.html;
    }
    console.log('[FAP MVP] Đã reset sau', TTL_MS / 60000, 'phút — như chưa tính');
  }

  function recalc() {
    if (dead) return null;
    expiresAt = Date.now() + TTL_MS; // gõ lại = gia hạn
    var resitOn = {};
    var i;
    for (i = 0; i < components.length; i++) {
      if (components[i].resit && readVal(components[i].input) != null) {
        resitOn[components[i].key] = true;
      }
    }

    var sum = 0;
    for (i = 0; i < components.length; i++) {
      var c = components[i];
      if (c.resit) {
        var rv = readVal(c.input);
        if (rv == null) continue;
        sum += (rv * c.weight) / 100;
        continue;
      }
      if (resitOn[c.key]) continue;
      var v = readVal(c.input);
      sum += ((v == null ? 0 : v) * c.weight) / 100;
    }

    var avg = Math.round(sum * 100) / 100;
    if (avgTd) avgTd.textContent = avg.toFixed(1);
    console.log('[FAP MVP] Average =', avg.toFixed(1));
    return avg;
  }

  for (var k = 0; k < components.length; k++) {
    components[k].input.oninput = recalc;
    components[k].input.onchange = recalc;
  }

  setInterval(function () {
    if (!dead && Date.now() >= expiresAt) teardown();
  }, 1000);
  setTimeout(function () {
    if (!dead) teardown();
  }, TTL_MS);

  var result = recalc();
  window.fapGradeMVP = fapGradeMVP;
  window.fapGradeMVPReset = teardown;
  console.log(
    '[FAP MVP] Ready —',
    components.length,
    'ô · Average:',
    result.toFixed(1),
    '· tự reset sau',
    TTL_MS / 60000,
    'phút · fapGradeMVPReset() để xóa ngay'
  );
})();
