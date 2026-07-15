// ==UserScript==
// @name         FAP Grade Calculator + GPA kỳ
// @namespace    https://github.com/Vlantoy/fap-grade-calculator
// @version      11.0.0
// @description  Tính điểm FAP tạm thời (mặc định 3 phút rồi tự reset). Weight + resit + GPA session ngắn hạn. Client-side only.
// @author       Vlantoy
// @homepageURL  https://vlantoy.github.io/fap-grade-calculator/
// @supportURL   https://github.com/Vlantoy/fap-grade-calculator/issues
// @downloadURL  https://raw.githubusercontent.com/Vlantoy/fap-grade-calculator/main/scripts/fap-grade-calculator.user.js
// @updateURL    https://raw.githubusercontent.com/Vlantoy/fap-grade-calculator/main/scripts/fap-grade-calculator.user.js
// @match        *://fap.fpt.edu.vn/Grade/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ===== Cấu hình thời gian sống (ms) — hết giờ = như chưa từng tính =====
  var TTL_MS = 3 * 60 * 1000; // 3 phút

  var WEIGHT_RE = /(\d+(?:[.,]\d+)?)\s*[%％]/;
  var RESIT_RE = /\bresit\b|thi\s*lại|thi\s*lai|retake|học\s*lại|hoc\s*lai/i;
  var STORE_KEY = 'fap_grade_calc_session_v2';
  var PANEL_ID = 'fap-gpa-panel';
  var EXPIRES_KEY = 'fap_grade_calc_expires_at';

  var sessionExpiresAt = 0;
  var ttlTimer = null;
  var countdownTimer = null;
  var teardownDone = false;
  var restoreSnapshots = []; // { el, html }
  var avgSnapshot = null; // { el, html }

  // ---------- helpers ----------
  function T(el) {
    if (!el) return '';
    var inp = el.querySelector && el.querySelector('input[data-fap-calc]');
    if (inp) return String(inp.value || '').trim();
    return ((el.innerText || el.textContent) || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function parseWeight(s) {
    var m = String(s || '').match(WEIGHT_RE);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }
  function parseScore(s) {
    s = String(s || '').replace(/\u00a0/g, ' ').trim().replace(',', '.');
    if (s === '' || s === '-' || s === '—') return null;
    if (WEIGHT_RE.test(s) && s.length <= 12) return null;
    var m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function isAvg(tr) {
    return /average|trung\s*b[iì]nh|điểm\s*trung|course\s*total|tổng\s*kết/i.test(T(tr));
  }
  function isTotalLabel(s) {
    return /^total$/i.test(String(s || '').trim());
  }
  function isResitName(name) {
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
  function clampScore(v) {
    if (v == null || !isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 10) return 10;
    return v;
  }
  function letterOf(m) {
    if (m == null || !isFinite(m)) return '—';
    if (m >= 9) return 'A+';
    if (m >= 8.5) return 'A';
    if (m >= 8) return 'B+';
    if (m >= 7) return 'B';
    if (m >= 6.5) return 'C+';
    if (m >= 5.5) return 'C';
    if (m >= 5) return 'D+';
    if (m >= 4) return 'D';
    return 'F';
  }
  function gpaPoint(m) {
    if (m == null || !isFinite(m) || m < 4) return 0;
    if (m >= 9) return 4.0;
    if (m >= 8.5) return 3.7;
    if (m >= 8) return 3.5;
    if (m >= 7) return 3.0;
    if (m >= 6.5) return 2.5;
    if (m >= 5.5) return 2.0;
    if (m >= 5) return 1.5;
    if (m >= 4) return 1.0;
    return 0;
  }
  function qs(name) {
    try {
      return new URL(location.href).searchParams.get(name) || '';
    } catch (e) {
      return '';
    }
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }
  function fmtRemain(ms) {
    if (ms <= 0) return '0:00';
    var s = Math.ceil(ms / 1000);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  // ---------- short-lived store ----------
  function loadStore() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return { courses: {}, expiresAt: 0 };
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return { courses: {}, expiresAt: 0 };
      if (!o.courses) o.courses = {};
      return o;
    } catch (e) {
      return { courses: {}, expiresAt: 0 };
    }
  }
  function saveStore(o) {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(o));
    } catch (e) {}
  }
  function clearStore() {
    try {
      sessionStorage.removeItem(STORE_KEY);
      sessionStorage.removeItem(EXPIRES_KEY);
    } catch (e) {}
  }
  function courseKey(term, courseId) {
    return String(term || '') + '|' + String(courseId || '');
  }

  function purgeIfExpired() {
    var now = Date.now();
    var store = loadStore();
    var exp = store.expiresAt || parseInt(sessionStorage.getItem(EXPIRES_KEY) || '0', 10) || 0;
    if (exp && now >= exp) {
      clearStore();
      return true;
    }
    // Xóa môn quá TTL kể từ updated
    var changed = false;
    var k;
    for (k in store.courses) {
      if (!Object.prototype.hasOwnProperty.call(store.courses, k)) continue;
      var c = store.courses[k];
      if (!c || !c.updated || now - c.updated > TTL_MS) {
        delete store.courses[k];
        changed = true;
      }
    }
    if (changed) saveStore(store);
    return false;
  }

  /** Gia hạn / khởi tạo thời điểm hết hạn cho cả session tính điểm */
  function touchExpiry() {
    var now = Date.now();
    if (!sessionExpiresAt || sessionExpiresAt < now) {
      sessionExpiresAt = now + TTL_MS;
    }
    // Mỗi lần tương tác: reset TTL (vài phút kể từ lần gõ cuối)
    sessionExpiresAt = now + TTL_MS;
    try {
      sessionStorage.setItem(EXPIRES_KEY, String(sessionExpiresAt));
    } catch (e) {}
    var st = loadStore();
    st.expiresAt = sessionExpiresAt;
    saveStore(st);
    scheduleTeardown();
    updateCountdownUi();
  }

  function remainingMs() {
    if (!sessionExpiresAt) {
      var exp = parseInt(sessionStorage.getItem(EXPIRES_KEY) || '0', 10) || 0;
      sessionExpiresAt = exp;
    }
    return Math.max(0, (sessionExpiresAt || 0) - Date.now());
  }

  // ---------- teardown: trở về như chưa tính ----------
  function teardown(reason) {
    if (teardownDone) return;
    teardownDone = true;
    if (ttlTimer) clearTimeout(ttlTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    ttlTimer = null;
    countdownTimer = null;

    // Gỡ input, khôi phục HTML gốc
    var i;
    for (i = 0; i < restoreSnapshots.length; i++) {
      var snap = restoreSnapshots[i];
      if (snap.el && snap.el.isConnected) {
        snap.el.innerHTML = snap.html;
      }
    }
    restoreSnapshots = [];
    if (avgSnapshot && avgSnapshot.el && avgSnapshot.el.isConnected) {
      avgSnapshot.el.innerHTML = avgSnapshot.html;
    }
    avgSnapshot = null;

    // Gỡ mọi input sót
    var leftovers = document.querySelectorAll('input[data-fap-calc]');
    for (i = 0; i < leftovers.length; i++) {
      var parent = leftovers[i].parentNode;
      if (parent) parent.textContent = leftovers[i].getAttribute('data-orig') || '';
    }

    // Gỡ badge inline + panel
    var badges = document.querySelectorAll('.fap-inline-avg');
    for (i = 0; i < badges.length; i++) badges[i].remove();
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();

    clearStore();
    console.log('[FAP Calc] Đã reset —', reason || 'hết thời gian', '— như chưa từng tính');
  }

  function scheduleTeardown() {
    if (ttlTimer) clearTimeout(ttlTimer);
    var left = remainingMs();
    if (left <= 0) {
      teardown('hết TTL');
      return;
    }
    ttlTimer = setTimeout(function () {
      teardown('hết ' + TTL_MS / 60000 + ' phút');
    }, left);
    if (!countdownTimer) {
      countdownTimer = setInterval(function () {
        if (remainingMs() <= 0) {
          teardown('hết TTL');
          return;
        }
        updateCountdownUi();
      }, 1000);
    }
  }

  function updateCountdownUi() {
    var el = document.getElementById('fap-gpa-ttl');
    if (!el) return;
    var left = remainingMs();
    el.textContent = 'Tự xóa sau ' + fmtRemain(left);
    el.style.color = left < 60000 ? '#fbbf24' : '#9ca3af';
  }

  // ---------- UI panel GPA ----------
  function ensurePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p) return p;
    p = document.createElement('div');
    p.id = PANEL_ID;
    p.setAttribute(
      'style',
      [
        'position:fixed',
        'right:12px',
        'bottom:12px',
        'z-index:999999',
        'width:300px',
        'max-height:70vh',
        'overflow:auto',
        'background:#111827',
        'color:#f3f4f6',
        'border-radius:10px',
        'box-shadow:0 8px 28px rgba(0,0,0,.4)',
        'font:13px/1.4 system-ui,Segoe UI,sans-serif',
      ].join(';')
    );
    p.innerHTML =
      '<div style="padding:8px 12px;background:#1f2937;font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:8px">' +
      '<span>GPA kỳ <span style="font-weight:500;font-size:11px;color:#9ca3af">(tạm)</span></span>' +
      '<button type="button" id="fap-gpa-x" style="border:0;background:0;color:#9ca3af;cursor:pointer;font-size:16px" title="Đóng & xóa ngay">×</button>' +
      '</div>' +
      '<div id="fap-gpa-ttl" style="padding:4px 12px 0;font-size:11px;color:#9ca3af"></div>' +
      '<div id="fap-gpa-body" style="padding:10px 12px"></div>';
    document.body.appendChild(p);
    p.querySelector('#fap-gpa-x').onclick = function () {
      teardown('user đóng panel');
    };
    return p;
  }

  function renderGpaPanel(termFilter) {
    if (teardownDone) return;
    if (purgeIfExpired()) {
      teardown('session hết hạn');
      return;
    }

    var store = loadStore();
    var list = [];
    var k;
    for (k in store.courses) {
      if (!Object.prototype.hasOwnProperty.call(store.courses, k)) continue;
      var c = store.courses[k];
      if (!c || c.avg == null || !isFinite(c.avg)) continue;
      if (termFilter && c.term && c.term !== termFilter) continue;
      list.push(c);
    }
    list.sort(function (a, b) {
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });

    ensurePanel();
    updateCountdownUi();
    var body = document.getElementById('fap-gpa-body');
    if (!body) return;

    if (!list.length) {
      body.innerHTML =
        '<div style="color:#9ca3af;font-size:12px">' +
        'Chưa có môn trong phiên tạm.<br>' +
        'Vào từng môn → nhập Value.<br>' +
        '<b style="color:#fbbf24">Tự xóa sau ' +
        TTL_MS / 60000 +
        ' phút</b> không dùng / hoặc bấm ×.' +
        '</div>';
      return;
    }

    var sum10 = 0;
    var sum4 = 0;
    var html =
      '<div style="margin-bottom:8px;font-size:12px;color:#9ca3af">Kỳ: ' +
      (termFilter || list[0].term || '—') +
      ' · ' +
      list.length +
      ' môn</div>';

    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      sum10 += m.avg;
      sum4 += gpaPoint(m.avg);
      html +=
        '<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid #374151">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px" title="' +
        escapeAttr(m.name || m.id) +
        '">' +
        escapeHtml(m.name || m.id) +
        '</span>' +
        '<span style="font-weight:700;color:#4ade80;white-space:nowrap">' +
        m.avg.toFixed(1) +
        ' <span style="color:#93c5fd;font-weight:600">' +
        letterOf(m.avg) +
        '</span></span></div>';
    }

    var avg10 = sum10 / list.length;
    var avg4 = sum4 / list.length;

    html +=
      '<div style="margin-top:12px;padding-top:8px;border-top:2px solid #4b5563">' +
      '<div>TB hệ 10: <b style="font-size:20px;color:#4ade80">' +
      avg10.toFixed(2) +
      '</b></div>' +
      '<div style="margin-top:4px">GPA (4.0): <b style="font-size:20px;color:#60a5fa">' +
      avg4.toFixed(2) +
      '</b></div>' +
      '<div style="margin-top:8px;font-size:11px;color:#6b7280">' +
      'Phiên tạm · hết giờ = reset như chưa tính.<br>' +
      'Gõ điểm lại = gia hạn thêm ' +
      TTL_MS / 60000 +
      ' phút.' +
      '</div></div>';

    body.innerHTML = html;
  }

  // ---------- Trang chi tiết 1 môn ----------
  function getGradeTable() {
    var root =
      document.getElementById('ctl00_mainContent_divGrade') ||
      document.querySelector('[id$="divGrade"]');
    return (
      (root && (root.querySelector('table[summary="Report"]') || root.querySelector('table'))) ||
      document.querySelector('table[summary="Report"]')
    );
  }

  function guessCourseName() {
    var cap = document.querySelector('#ctl00_mainContent_divGrade caption, [id$="divGrade"] caption');
    if (cap && T(cap)) return T(cap).replace(/\s*then see report.*/i, '').trim();
    var h2 = document.querySelector('#ctl00_mainContent_divGrade h2, [id$="divGrade"] h2, h2');
    if (h2 && T(h2).length > 2 && T(h2).length < 120) return T(h2);
    var sel = document.querySelector('a[href*="course="].active, select option:checked');
    if (sel && T(sel)) return T(sel);
    return qs('course') || 'Course';
  }

  function wireCourseDetail() {
    if (teardownDone) return false;
    if (purgeIfExpired()) return false;

    var table = getGradeTable();
    if (!table || !table.rows || table.rows.length < 2) return false;
    if (document.querySelector('input[data-fap-calc]')) return true;

    var term = qs('term');
    var courseId = qs('course');
    var roll = qs('rollNumber');
    var components = [];
    var avgTd = null;

    var store = loadStore();
    // Chỉ restore value nếu session còn hạn
    var ck = courseKey(term, courseId);
    var saved = store.courses[ck] || null;
    var savedValues = saved && saved.values && Date.now() - (saved.updated || 0) < TTL_MS ? saved.values : {};

    for (var r = 0; r < table.rows.length; r++) {
      var tr = table.rows[r];
      var cells = tr.cells;
      if (!cells || !cells.length) continue;

      if (isAvg(tr)) {
        for (var a = 0; a < cells.length; a++) {
          if (parseWeight(T(cells[a])) != null) continue;
          if (parseScore(T(cells[a])) != null) {
            avgTd = cells[a];
            break;
          }
        }
        if (!avgTd) avgTd = cells[cells.length - 1];
        continue;
      }

      for (var c = 0; c < cells.length; c++) {
        var wt = T(cells[c]);
        var w = parseWeight(wt);
        if (w == null || w <= 0 || w > 100 || wt.length > 14) continue;

        var itemName = c > 0 ? T(cells[c - 1]) : '';
        if (isTotalLabel(itemName)) continue;

        var valTd = cells[c + 1];
        if (!valTd || parseWeight(T(valTd)) != null) continue;

        var origHtml = valTd.innerHTML;
        restoreSnapshots.push({ el: valTd, html: origHtml });

        var existing = parseScore(T(valTd));
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.setAttribute('data-fap-calc', '1');
        inp.setAttribute('data-weight', String(w));
        inp.setAttribute('data-name', itemName);
        inp.setAttribute('data-resit', isResitName(itemName) ? '1' : '0');
        inp.setAttribute('data-key', baseKey(itemName));
        inp.setAttribute('data-orig', existing != null ? String(existing) : '');

        if (existing != null) {
          inp.value = String(existing);
        } else if (savedValues[itemName] != null && savedValues[itemName] !== '') {
          inp.value = String(savedValues[itemName]);
        } else {
          inp.value = '';
        }

        inp.placeholder = '0';
        inp.title = isResitName(itemName) ? 'Thi lại — có điểm sẽ thay lần 1' : itemName || 'Value';
        inp.size = 5;
        inp.style.cssText = 'width:52px;height:22px;';
        valTd.textContent = '';
        valTd.appendChild(inp);

        components.push({
          name: itemName,
          weight: w,
          input: inp,
          resit: isResitName(itemName),
          key: baseKey(itemName),
        });
      }
    }

    if (!components.length) return false;

    if (avgTd) {
      avgSnapshot = { el: avgTd, html: avgTd.innerHTML };
    }

    function readVal(inp) {
      var raw = String(inp.value || '').trim();
      if (raw === '') return null;
      var v = parseScore(raw);
      return v == null ? null : clampScore(v);
    }

    function recalc() {
      if (teardownDone) return;
      touchExpiry();

      var resitActive = {};
      var i;
      for (i = 0; i < components.length; i++) {
        if (!components[i].resit || !components[i].input.isConnected) continue;
        if (readVal(components[i].input) != null) resitActive[components[i].key] = true;
      }

      var sum = 0;
      var values = {};
      for (i = 0; i < components.length; i++) {
        var comp = components[i];
        if (!comp.input.isConnected) continue;
        var weight = parseFloat(comp.input.getAttribute('data-weight')) || comp.weight;
        values[comp.name] = String(comp.input.value || '').trim();

        if (comp.resit) {
          var rv = readVal(comp.input);
          if (rv == null) continue;
          sum += (rv * weight) / 100;
          continue;
        }
        if (resitActive[comp.key]) continue;
        var v1 = readVal(comp.input);
        sum += ((v1 == null ? 0 : v1) * weight) / 100;
      }

      var avg = Math.round(sum * 100) / 100;
      if (avgTd) {
        var bad = avgTd.querySelector('input[data-fap-calc]');
        if (bad) bad.remove();
        avgTd.textContent = avg.toFixed(1);
      }

      if (courseId) {
        var st = loadStore();
        st.rollNumber = roll || st.rollNumber;
        st.term = term || st.term;
        st.expiresAt = sessionExpiresAt;
        st.courses[courseKey(term, courseId)] = {
          id: courseId,
          term: term,
          name: guessCourseName(),
          avg: avg,
          letter: letterOf(avg),
          gpa4: gpaPoint(avg),
          values: values,
          updated: Date.now(),
        };
        saveStore(st);
        renderGpaPanel(term);
      }

      return avg;
    }

    for (var k = 0; k < components.length; k++) {
      components[k].input.oninput = recalc;
      components[k].input.onchange = recalc;
    }

    touchExpiry();
    recalc();
    console.log(
      '[FAP Calc] OK',
      components.length,
      'ô · tự reset sau',
      TTL_MS / 60000,
      'phút không dùng'
    );
    return true;
  }

  function scrapeOverviewLinks() {
    if (teardownDone) return;
    var store = loadStore();
    var term = qs('term') || store.term || '';
    var links = document.querySelectorAll('a[href*="StudentGrade.aspx"], a[href*="course="]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute('href') || '';
      var m = href.match(/[?&]course=([^&]+)/i);
      if (!m) continue;
      var id = decodeURIComponent(m[1]);
      var tMatch = href.match(/[?&]term=([^&]+)/i);
      var t = tMatch ? decodeURIComponent(tMatch[1]) : term;
      var rec = store.courses[courseKey(t, id)];
      if (!rec || rec.avg == null) continue;
      if (a.parentNode && a.parentNode.querySelector('.fap-inline-avg')) continue;
      var span = document.createElement('span');
      span.className = 'fap-inline-avg';
      span.style.cssText = 'margin-left:6px;color:#16a34a;font-weight:700';
      span.textContent = '[' + rec.avg.toFixed(1) + ' ' + letterOf(rec.avg) + ']';
      a.insertAdjacentElement('afterend', span);
    }
  }

  function bootOverview() {
    if (purgeIfExpired()) return;
    var exp = parseInt(sessionStorage.getItem(EXPIRES_KEY) || '0', 10) || 0;
    if (exp > Date.now()) {
      sessionExpiresAt = exp;
      scheduleTeardown();
    } else if (Object.keys(loadStore().courses || {}).length) {
      // có data cũ không hạn → xóa
      clearStore();
      return;
    } else {
      return; // không có gì để hiện
    }
    var term = qs('term') || loadStore().term || '';
    renderGpaPanel(term);
    scrapeOverviewLinks();
    window.addEventListener('focus', function () {
      if (teardownDone) return;
      if (purgeIfExpired()) {
        teardown('hết hạn khi focus');
        return;
      }
      renderGpaPanel(qs('term') || loadStore().term || '');
      scrapeOverviewLinks();
    });
  }

  function boot() {
    purgeIfExpired();

    var course = qs('course');
    var table = getGradeTable();
    var hasDetail = table && WEIGHT_RE.test(T(table)) && course;

    if (hasDetail) {
      var n = 0;
      var t = setInterval(function () {
        n++;
        if (wireCourseDetail() || n > 40) clearInterval(t);
      }, 400);
      return;
    }

    bootOverview();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
