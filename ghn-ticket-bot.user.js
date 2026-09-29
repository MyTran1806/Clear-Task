// ==UserScript==
// @name         Auto xử lý phiếu sự cố
// @namespace    ghn-ticket-bot
// @version      3.13.1
// @description  Tự động xử lý phiếu sự cố GHN: Quá hạn toàn trình / Không giao-lấy-trả đúng số lần / COD không tích giao thành công. Không gọi API, không cần nhập token — tra cứu ưu tiên khung ẩn (không hiện tab), dự phòng 1 tab nền dùng chung cho cả lượt chạy.
// @match        https://noibo.ghn.vn/*
// @match        https://tracuunoibo.ghn.vn/*
// @match        https://nhanh.ghn.vn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        GM_info
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/MyTran1806/Clear-Task/main/ghn-ticket-bot.user.js
// @downloadURL  https://raw.githubusercontent.com/MyTran1806/Clear-Task/main/ghn-ticket-bot.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ======================================================================
  // Bộ đếm giờ chạy trong Web Worker: Chrome làm chậm mạnh setTimeout của tab bị
  // ẩn/che kín (có lúc chỉ chạy 1 lần/phút), còn timer trong Worker thì không bị vậy.
  // Nếu Worker bị chặn thì tự quay về setTimeout thường.
  // ======================================================================
  const sleep = (() => {
    let worker = null;
    let ok = false;
    let seq = 0;
    const pending = new Map();
    const failAll = () => {
      ok = false;
      pending.forEach((r) => r());
      pending.clear();
    };
    try {
      const src = 'onmessage=function(e){var d=e.data;setTimeout(function(){postMessage(d.id)},d.ms)}';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      worker.onmessage = (e) => {
        const r = pending.get(e.data);
        if (r) { pending.delete(e.data); r(); }
      };
      worker.onerror = failAll;
      ok = true;
    } catch (e) {
      ok = false;
    }
    return (ms) =>
      new Promise((resolve) => {
        if (!ok) return void setTimeout(resolve, ms);
        const id = ++seq;
        pending.set(id, resolve);
        try { worker.postMessage({ id, ms }); } catch (e) { pending.delete(id); ok = false; return void setTimeout(resolve, ms); }
        // dự phòng: Worker im lặng (bị chặn ngầm) thì vẫn thoát được
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(); } }, ms + 5000);
      });
  })();

  // ======================================================================
  // Phần 1: chạy trên tracuunoibo.ghn.vn — khi trang được mở với ?order_code=XXX
  // (do bot mở), ĐỌC KẾT QUẢ HIỂN THỊ trên màn hình (Trạng thái vận hành...) rồi
  // báo lại cho tab phiếu. Không gọi API, không đụng token.
  // ======================================================================
  if (location.hostname === 'tracuunoibo.ghn.vn') {
    const params = new URLSearchParams(location.search);
    const isWorker = params.get('worker') === '1';
    const workerRsid = params.get('rsid') || '';
    const code = params.get('order_code');
    if (!isWorker && !code) return;
    const leafByText = (t) =>
      Array.from(document.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent.trim() === t) || null;
    const valueOf = (label) => {
      const el = leafByText(label);
      return el && el.nextElementSibling ? el.nextElementSibling.textContent.trim() : '';
    };
    const nextLeafText = (label) => {
      const el = leafByText(label);
      if (!el) return '';
      const leaves = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0);
      const i = leaves.indexOf(el);
      return leaves[i + 1] ? leaves[i + 1].textContent.trim() : '';
    };
    // Lấy chữ của ô cách nhãn `label` `offset` ô (theo thứ tự các ô lá trên trang) — dùng để
    // đọc thêm nhãn trạng thái ("Đã thu"/"Chưa thu") nằm ngay sau giá trị tiền.
    const leafAfter = (label, offset) => {
      const el = leafByText(label);
      if (!el) return '';
      const leaves = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0);
      const i = leaves.indexOf(el);
      return leaves[i + offset] ? leaves[i + offset].textContent.trim() : '';
    };
    // Đọc tab "Lịch sử đơn hàng": mỗi log = 1 dòng (giờ, thao tác, chi tiết, kho, người
    // thao tác), gom theo tiêu đề ngày. Giờ hiển thị là giờ Việt Nam (UTC+7).
    const parseHistory = async () => {
      const tab = Array.from(document.querySelectorAll('nav a[role=tab]')).find(
        (a) => a.textContent.trim() === 'Lịch sử đơn hàng'
      );
      if (!tab) return null;
      tab.click();
      // Danh sách có thể nạp dần → chờ tới khi số dòng KHÔNG đổi trong 2 giây mới đọc
      // (đọc sớm sẽ thiếu dòng, làm rule kết luận sai).
      const start = Date.now();
      let rt = null;
      let lastN = -1;
      let stableSince = Date.now();
      while (Date.now() - start < 25000) {
        rt = document.querySelector('#order-tab-tabpane-order-history .responsive-table');
        const n = rt ? rt.querySelectorAll('.table-row').length : 0;
        if (n !== lastN) { lastN = n; stableSince = Date.now(); }
        else if (n > 0 && Date.now() - stableSince >= 2000) break;
        await sleep(250);
      }
      if (!rt || !rt.querySelector('.table-row')) return null;
      const rows = [];
      let date = null;
      Array.from(rt.children).forEach((k) => {
        const cls = k.className.toString();
        if (/table-header/.test(cls)) {
          const m = k.textContent.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          date = m ? { d: +m[1], mo: +m[2], y: +m[3] } : null;
          return;
        }
        if (!/table-row/.test(cls) || !date) return;
        const c = k.children;
        const tm = (c[0] ? c[0].textContent.trim() : '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!tm) return;
        const changes = [];
        if (c[2]) {
          c[2].querySelectorAll('div').forEach((d) => {
            if (d.querySelector('div')) return;
            if (!d.textContent.trim().startsWith('Thay đổi trạng thái')) return;
            const sp = d.querySelectorAll('.text-hightlight');
            if (sp.length >= 2) changes.push({ from: sp[0].textContent.trim(), to: sp[1].textContent.trim() });
          });
        }
        rows.push({
          ts: Date.UTC(date.y, date.mo - 1, date.d, +tm[1] - 7, +tm[2], tm[3] ? +tm[3] : 0),
          action: (c[1] ? c[1].textContent : '').trim(),
          changes,
          executor: (c[4] ? c[4].textContent : '').replace(/\s+/g, ' ').trim(),
          client: /\bclient\b/.test(cls), // dòng do Shop thao tác (màu xanh)
        });
      });
      return rows;
    };

    // Đọc cước ở tab "Chi tiết đơn hàng", khung "Tiền": bấm con mắt để hiện số, bấm ba chấm
    // cạnh "Tổng phí dịch vụ" để mở chi tiết phí, rồi lấy "Tổng phí dịch vụ" và "Phí khai giá".
    const parseMoney = (t) => {
      const m = String(t || '').match(/\d[\d.,]*/);
      if (!m) return null;
      const n = parseInt(m[0].replace(/[.,]/g, ''), 10);
      return Number.isNaN(n) ? null : n;
    };
    const readFees = async () => {
      const head = leafByText('Tiền');
      if (!head || !head.parentElement) return null;
      // Nút con mắt = icon thứ 2 trong tiêu đề khung "Tiền" (icon thứ 1 là cây bút SỬA — tuyệt đối không bấm).
      const isPencil = (s) => {
        const p = s.querySelector('path');
        return !!p && (p.getAttribute('d') || '').startsWith('M18.162 20.6667');
      };
      const eye = Array.from(head.parentElement.querySelectorAll('svg')).filter((s) => !isPencil(s)).pop();
      const valueOfLabel = (label) => valueOf(label);
      const hasDigit = (t) => /\d/.test(t || '');
      // Đang ẩn số ("xxxxx") thì bấm con mắt cho hiện.
      if (!hasDigit(valueOfLabel('Tổng phí dịch vụ:')) && eye) {
        eye.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      let t0 = Date.now();
      while (!hasDigit(valueOfLabel('Tổng phí dịch vụ:')) && Date.now() - t0 < 12000) await sleep(250);
      if (!hasDigit(valueOfLabel('Tổng phí dịch vụ:'))) return null;
      // Mở chi tiết phí (ba chấm) để thấy "Phí khai giá".
      const toggle = document.querySelector('[aria-controls="money-collapse"]');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      t0 = Date.now();
      while (!hasDigit(valueOfLabel('Phí khai giá:')) && Date.now() - t0 < 12000) await sleep(250);
      if (!hasDigit(valueOfLabel('Phí khai giá:'))) return null;
      const totalText = valueOfLabel('Tổng phí dịch vụ:');
      const khaiGiaText = valueOfLabel('Phí khai giá:');
      // "Giao thất bại - thu tiền": ô giá trị rồi tới nhãn trạng thái "Đã thu"/"Chưa thu" ngay
      // sau đó (2 ô lá kể từ nhãn). Không có dòng này ở đơn → gtbCollected = null.
      const gtbLabel = 'Giao thất bại - thu tiền:';
      let gtbCollected = null;
      let gtbStatusText = '';
      if (leafByText(gtbLabel)) {
        gtbStatusText = leafAfter(gtbLabel, 2);
        if (/đã thu/i.test(gtbStatusText)) gtbCollected = true;
        else if (/chưa thu/i.test(gtbStatusText)) gtbCollected = false;
      }
      return {
        total: parseMoney(totalText), khaiGia: parseMoney(khaiGiaText), totalText, khaiGiaText,
        gtbCollected, gtbStatusText,
      };
    };

    async function doLookup(code, opts) {
      const start = Date.now();
      let result = null;
      while (Date.now() - start < 35000) {
        if (leafByText('Không thể tìm kiếm mã đơn hàng')) {
          result = { ok: false, error: `Trang tra cứu báo không tìm được đơn ${code}` };
          break;
        }
        const vh = valueOf('Trạng thái vận hành');
        // Chỉ nhận kết quả khi trang đã hiện ĐÚNG mã đơn cần tra (tránh đọc nhầm dữ liệu cũ).
        if (vh && nextLeafText('Mã đơn hàng') === code) {
          result = { ok: true, vh, kh: valueOf('Trạng thái khách hàng'), lc: valueOf('Trạng thái luân chuyển'), khoGiao: valueOf('Kho giao') };
          break;
        }
        await sleep(300);
      }
      if (!result) result = { ok: false, error: 'Hết thời gian chờ trang tra cứu hiện kết quả' };
      const vhNorm = String(result.vh || '').replace(/\s+/g, ' ').trim().toLowerCase();
      // Chỉ đọc lịch sử khi cần (đơn đang ở đúng trạng thái yêu cầu) để chạy nhanh hơn.
      // Danh sách này phải khớp QHTT_VH phía trang phiếu.
      if (result.ok && opts.hist && ['lưu kho chờ trả', 'đang luân chuyển trả', 'lưu kho trả', 'đang trả hàng', 'đã trả hàng'].includes(vhNorm)) {
        let h = null;
        try { h = await parseHistory(); } catch (e) {}
        if (h) result.history = h;
        else { result.ok = false; result.error = 'Không đọc được "Lịch sử đơn hàng" của đơn ' + code; }
      }
      // Cước chỉ đọc khi được yêu cầu, và (nếu có cờ) chỉ khi đơn thuộc nhóm hoàn/trả.
      // (Điều kiện ở đây phải khớp hàm isReturnGroupVh phía trang phiếu.)
      if (result.ok && opts.fee) {
        const isRet = ['đang luân chuyển trả', 'lưu kho trả', 'đang trả hàng', 'đã trả hàng'].includes(vhNorm);
        if (!opts.feeIfReturnGroup || isRet) {
          let f = null;
          try { f = await readFees(); } catch (e) {}
          if (f && f.total != null && f.khaiGia != null) result.fee = f;
          else { result.ok = false; result.error = 'Không đọc được "Tổng phí dịch vụ"/"Phí khai giá" của đơn ' + code; }
        }
      }
      result.t = Date.now();
      GM_setValue('lookup_' + code, result);
    }

    if (isWorker) {
      // Tab nền DÙNG CHUNG cho cả lượt chạy: nhận yêu cầu tra từng đơn qua bộ nhớ, tự tra rồi
      // chờ yêu cầu tiếp theo — KHÔNG mở/đóng tab riêng cho từng đơn nữa (đỡ giật tab liên tục).
      // Tự đóng khi lượt chạy đã kết thúc/đổi, hoặc rảnh quá lâu (không ai gửi yêu cầu mới).
      (async () => {
        let lastReqT = 0;
        let idleSince = Date.now();
        for (;;) {
          GM_setValue('worker_alive_at', Date.now());
          GM_setValue('worker_rsid', workerRsid);
          if (String(GM_getValue('run_session_id', '') || '') !== workerRsid) break; // lượt chạy đã đổi/kết thúc
          const req = GM_getValue('worker_nav_request', null);
          if (req && req.rsid === workerRsid && req.t > lastReqT) {
            lastReqT = req.t;
            idleSince = Date.now();
            const opts = GM_getValue('lookup_opts_' + req.code, null) || {};
            try { await doLookup(req.code, opts); } catch (e) {}
          } else if (Date.now() - idleSince > 90000) {
            break; // rảnh quá lâu — tự đóng, lần tra sau sẽ mở tab nền mới
          }
          await sleep(400);
        }
        try { window.close(); } catch (e) {}
      })();
      return;
    }

    // Chế độ 1 đơn (dự phòng): mở tab riêng cho 1 đơn khi tab nền dùng chung không dùng được.
    (async () => {
      const opts = GM_getValue('lookup_opts_' + code, null) || {};
      await doLookup(code, opts);
    })();
    return;
  }
  // ======================================================================
  // Phần 1b: chạy trên nhanh.ghn.vn (Lastmile) — CHỈ khi được bot mở làm "tab nền Lastmile"
  // (?worker=1&rsid=...). Nhận yêu cầu {mã đơn, ID BC giao} → chọn đúng BC ở góc phải, tìm đơn
  // ở ô "Nhập mã ĐH", đọc "Số tiền đã thu khi giao thất bại", rồi báo lại. Mở 1 lần cho cả lượt chạy, tự đóng khi xong.
  // ======================================================================
  if (location.hostname === 'nhanh.ghn.vn') {
    let navUrl = location.href;
    try { navUrl = performance.getEntriesByType('navigation')[0].name || navUrl; } catch (e) {}
    const qp = new URLSearchParams((navUrl.split('?')[1] || '').split('#')[0]);
    // Trang Lastmile tự chuyển /lastmile → /lastmile/trip-list (mất tham số) và TẢI LẠI mỗi khi đổi
    // BC, nên mã lượt chạy được nhớ trong sessionStorage (sống qua các lần tải lại của tab này).
    let lmRsid = qp.get('worker') === '1' ? qp.get('rsid') || '' : null;
    try {
      if (lmRsid !== null) sessionStorage.setItem('ghnbot_lm_rsid', lmRsid);
      else lmRsid = sessionStorage.getItem('ghnbot_lm_rsid');
    } catch (e) {}
    if (lmRsid === null) return;
    // BC đang chọn được lưu ở localStorage (CURRENT_HUB, dùng chung mọi tab Lastmile) → nhớ lại
    // BC gốc của người dùng để trả về khi xong, khỏi làm lệch công việc Lastmile của họ.
    const hubKey = 'lm_orig_hub_' + lmRsid;
    try {
      if (GM_getValue(hubKey, null) === null) GM_setValue(hubKey, localStorage.getItem('CURRENT_HUB') || '');
    } catch (e) {}

    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const until = async (fn, ms) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = fn(); } catch (e) {}
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(250);
      }
    };
    const setVal = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const parseMoney = (t) => {
      const m = String(t || '').match(/\d[\d.,]*/);
      if (!m) return null;
      const n = parseInt(m[0].replace(/[.,]/g, ''), 10);
      return Number.isNaN(n) ? null : n;
    };
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const leafIn = (root, text) =>
      Array.from(root.querySelectorAll('*')).find((e) => e.children.length === 0 && norm(e.textContent) === norm(text)) || null;
    const valueAfter = (el) => {
      for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) {
        if (e.nextElementSibling) return e.nextElementSibling.textContent.trim();
      }
      return '';
    };

    // Ô chọn BC = ô .ant-select nằm sát mép trên, ngoài cùng bên phải.
    const bcSelect = () => {
      const sels = Array.from(document.querySelectorAll('.ant-select')).filter((s) => vis(s) && s.getBoundingClientRect().top < 160);
      sels.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      return sels[0] || null;
    };
    const ensureBc = async (bc) => {
      const sel = await until(bcSelect, 40000);
      if (!sel) throw new Error('Lastmile: không thấy ô chọn BC ở góc phải (đã đăng nhập nhanh.ghn.vn chưa?)');
      const cur = () => norm((sel.querySelector('.ant-select-content') || sel.querySelector('.ant-select-selection-item') || {}).textContent);
      if (cur().startsWith(bc)) return;
      const input = sel.querySelector('input');
      if (!input) throw new Error('Lastmile: ô chọn BC không có ô nhập để gõ ID');
      sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.focus();
      setVal(input, bc);
      const opt = await until(
        () => Array.from(document.querySelectorAll('.ant-select-item-option')).filter(vis).find((o) => norm(o.textContent).startsWith(bc)),
        10000
      );
      if (!opt) throw new Error('Lastmile: không có BC "' + bc + '" trong danh sách chọn');
      opt.click();
      // Chọn BC làm trang TẢI LẠI → script này sẽ chết ở đây, bản chạy sau khi tải lại (BC đã
      // đúng) tự làm tiếp yêu cầu đang chờ. Nếu không tải lại thì đợi ô chọn đổi.
      const ok = await until(() => cur().startsWith(bc), 15000);
      if (!ok) throw new Error('Lastmile: đã chọn BC "' + bc + '" nhưng ô chọn chưa đổi');
      await sleep(1500);
    };

    const closeModals = async () => {
      for (let i = 0; i < 3; i++) {
        const m = Array.from(document.querySelectorAll('.ant-modal')).find(vis);
        if (!m) return;
        const closeBtn =
          Array.from(m.querySelectorAll('button')).find((b) => norm(b.textContent) === 'đóng') || m.querySelector('.ant-modal-close');
        if (closeBtn) closeBtn.click();
        await sleep(600);
      }
    };

    const searchInput = () => Array.from(document.querySelectorAll('input')).find((i) => vis(i) && /nhập mã đh/i.test(i.placeholder || ''));
    const findSearchButton = (input) => {
      for (let e = input.parentElement, i = 0; e && i < 5; e = e.parentElement, i++) {
        const b = e.querySelector('button');
        if (b && vis(b)) return b;
      }
      return null;
    };
    const doLm = async (code, bc) => {
      await ensureBc(bc);
      await closeModals();
      const input = await until(searchInput, 20000);
      if (!input) throw new Error('Lastmile: không thấy ô "Nhập mã ĐH"');
      input.focus();
      setVal(input, code);
      await sleep(300);
      const findModal = () => Array.from(document.querySelectorAll('.ant-modal')).filter(vis).find((m) => m.textContent.includes(code));
      const btn = findSearchButton(input);
      if (btn) btn.click();
      let modal = await until(findModal, 12000);
      if (!modal) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
        modal = await until(findModal, 12000);
      }
      if (!modal) throw new Error('Lastmile: tìm mã đơn ' + code + ' không ra bảng đơn hàng (có thể chọn sai BC ' + bc + ')');

      // Số tiền đã thu khi giao thất bại
      // (Lúc mới mở bảng ô này ghi "Đang lấy dữ liệu..." → phải chờ tới khi có số.)
      const lab = await until(() => leafIn(modal, 'Số tiền đã thu khi giao thất bại'), 8000);
      if (!lab) throw new Error('Lastmile: không thấy dòng "Số tiền đã thu khi giao thất bại" của đơn ' + code);
      const amountText = await until(() => {
        const l = leafIn(modal, 'Số tiền đã thu khi giao thất bại');
        const v = l ? valueAfter(l) : '';
        return /\d/.test(v) ? v : null;
      }, 20000);
      const amount = parseMoney(amountText);
      if (amount == null) throw new Error('Lastmile: dòng "Số tiền đã thu khi giao thất bại" của đơn ' + code + ' chưa hiện số sau 20 giây');

      await closeModals();
      return { ok: true, amount, amountText, bc };
    };

    (async () => {
      let lastReqT = 0;
      let idleSince = Date.now();
      for (;;) {
        GM_setValue('lm_worker_alive_at', Date.now());
        GM_setValue('lm_worker_rsid', lmRsid);
        if (String(GM_getValue('run_session_id', '') || '') !== lmRsid) break; // lượt chạy đã đổi/kết thúc
        const req = GM_getValue('lm_request', null);
        if (req && req.rsid === lmRsid && req.t > lastReqT) {
          lastReqT = req.t;
          idleSince = Date.now();
          let out;
          try { out = await doLm(req.code, req.bc); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
          out.t = Date.now();
          GM_setValue('lm_result_' + req.code, out);
        } else if (Date.now() - idleSince > 120000) {
          break;
        }
        await sleep(400);
      }
      // Kết thúc: trả BC về như ban đầu của người dùng, xoá dấu "tab nền" rồi tự đóng.
      try {
        const orig = GM_getValue(hubKey, '');
        if (orig) localStorage.setItem('CURRENT_HUB', orig);
        GM_setValue(hubKey, null);
      } catch (e) {}
      try { sessionStorage.removeItem('ghnbot_lm_rsid'); } catch (e) {}
      try { window.close(); } catch (e) {}
    })();
    return;
  }
  if (location.hostname !== 'noibo.ghn.vn') return;
  if (window.top !== window.self) return; // trang noibo nằm trong khung khác thì bỏ qua

  const ORIGIN = 'https://noibo.ghn.vn';
  const HOST_ID = 'ghn-ticket-bot-host';
  const TRIGGER_ID = 'ghn-ticket-bot-trigger';
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';

  // ======================================================================
  // QUY TẮC — chỉnh tại đây nếu cần đổi nội dung ghi chú / kết quả trả về
  // ======================================================================
  const NOTE_DELIVERED = 'Giao thành công';
  const NOTE_RETURNED = 'Trả thành công';
  const NOTE_NEW_LOG = 'Đơn hàng đã có PLC/Log xử lý mới';
  // Tổng cước đền bù = Tổng phí dịch vụ − Phí khai giá (cộng dồn nếu phiếu có nhiều đơn).
  const fmtMoney = (n) => `${Number(n).toLocaleString('en-US')}đ`;
  const overdueComment = (amount) => `Quá SLA đơn hàng không giải trình, CS chốt đền bù tổng cước ${fmtMoney(amount)} cho Seller`;
  const REASSIGN_ID = '3062182';
  const REASSIGN_NAME = 'Trần Thị Ngọc Như';
  const RULES = [
    {
      key: 'QHTT',
      label: 'Đơn hàng bị quá hạn toàn trình',
      concludeOn: { delivered: NOTE_DELIVERED, returned: NOTE_RETURNED },
      otherResult: 'CS theo dõi',
    },
    {
      key: 'SAI_SO_LAN',
      label: 'Không giao/ lấy/ trả đúng số lần quy định',
      concludeOn: { delivered: NOTE_DELIVERED },
      otherResult: 'CS theo dõi',
    },
    {
      key: 'COD',
      label: 'Khách đã nhận hàng thanh toán COD nhưng không tích giao thành công',
      concludeOn: { delivered: NOTE_DELIVERED },
      otherResult: 'CS check lại',
    },
  ];
  const normLabel = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim().toLowerCase();
  const ruleByLabel = (label) => RULES.find((r) => normLabel(r.label) === normLabel(label)) || null;

  // ======================================================================
  // Bộ nhớ (GM storage dùng chung giữa các trang của script)
  // ======================================================================
  const sget = (k, d) => {
    const v = GM_getValue(k, d);
    return v === undefined || v === null ? d : v;
  };
  const sset = (k, v) => { GM_setValue(k, v); return Promise.resolve(); };
  const isRunActive = async () => !!sget('run_active', false);
  // Báo cho tab nền dùng chung (nếu có) biết lượt chạy đã dừng/xong, để nó tự đóng.
  const clearRunSession = () => sset('run_session_id', null);

  // Mỗi tab có 1 mã riêng (sessionStorage sống qua các lần chuyển trang cùng tab)
  // — chỉ tab đã bấm "Bắt đầu" mới điều khiển lượt chạy, tránh lẫn lộn giữa các tab.
  function getMyTabId() {
    try {
      let id = sessionStorage.getItem('ghnbot_tab_uid');
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('ghnbot_tab_uid', id);
      }
      return id;
    } catch (e) {
      return null;
    }
  }

  // ======================================================================
  // Log
  // ======================================================================
  let ui = null;
  function renderLog() {
    if (!ui || !ui.logEl) return;
    ui.logEl.textContent = sget('run_log', []).join('\n');
    ui.logEl.scrollTop = ui.logEl.scrollHeight;
  }
  function log(msg) {
    console.log('[GHN-Bot]', msg);
    const arr = sget('run_log', []);
    arr.push(`[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`);
    while (arr.length > 300) arr.shift();
    sset('run_log', arr);
    renderLog();
  }

  // ======================================================================
  // Tra cứu đơn hàng: bot mở 1 TAB NỀN DÙNG CHUNG cho cả lượt chạy (mở 1 lần, tự điều hướng
  // nội bộ cho từng đơn) — không mở/đóng tab riêng cho từng đơn nữa. Nếu tab nền không dùng
  // được thì mới dự phòng mở tab riêng cho đơn đó. Trang tra cứu (Phần 1 ở trên) đọc kết quả
  // hiển thị và báo lại qua bộ nhớ chung. KHÔNG gọi API, KHÔNG token.
  // ======================================================================
  async function waitForLookupResult(key, openedAt, timeoutMs, fatalOnTimeout, errMsg) {
    let got = null;
    let listenerId = null;
    try { listenerId = GM_addValueChangeListener(key, (name, oldV, newV) => { if (newV && newV.t >= openedAt) got = newV; }); } catch (e) {}
    try {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (!got) {
          const r = GM_getValue(key, null);
          if (r && r.t >= openedAt) got = r;
        }
        if (got) return got;
        await sleep(400);
      }
    } finally {
      if (listenerId != null) { try { GM_removeValueChangeListener(listenerId); } catch (e) {} }
    }
    const err = new Error(
      errMsg || 'Không nhận được kết quả từ trang tra cứu — kiểm tra đã đăng nhập https://tracuunoibo.ghn.vn (cùng trình duyệt) chưa.'
    );
    err.timeout = true;
    err.fatal = !!fatalOnTimeout; // lỗi hệ thống: dừng cả lượt chạy thay vì lặp lại ở từng phiếu
    throw err;
  }

  const lookupUrl = (code) => 'https://tracuunoibo.ghn.vn/internal?order_code=' + encodeURIComponent(code);
  const workerUrl = (rsid) => 'https://tracuunoibo.ghn.vn/internal?worker=1&rsid=' + encodeURIComponent(rsid);

  // Cách 0 (ưu tiên — hoàn toàn không hiện tab nào): nhúng trang tra cứu vào 1 khung ẩn ngay
  // trong trang phiếu. Nếu trình duyệt chặn khung ẩn đọc được đăng nhập (một số Chrome mới chặn
  // iframe khác nguồn đọc localStorage) thì sẽ timeout và tự rớt xuống Cách 1 (tab nền dùng chung).
  async function lookupViaFrame(code, timeoutMs) {
    const key = 'lookup_' + code;
    const openedAt = Date.now();
    GM_setValue(key, null);
    const f = document.createElement('iframe');
    f.src = lookupUrl(code);
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    f.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;';
    document.documentElement.appendChild(f);
    try {
      return await waitForLookupResult(key, openedAt, timeoutMs, false);
    } finally {
      f.remove();
    }
  }

  // Đảm bảo có tab nền còn sống cho lượt chạy hiện tại (rsid) — mở nếu chưa có (hoặc tab cũ đã
  // chết), chờ tối đa 55s cho lần mở đầu (tab nền tải nền nên có thể chậm hơn tab đang xem —
  // 20s từng bị hụt, khiến lượt chạy nào cũng rớt về mở tab riêng từng đơn). Tab nền tự
  // heartbeat mỗi ~0.4s, còn sống thì các đơn sau trong cùng lượt chạy dùng lại luôn, khỏi mở
  // tab mới nữa.
  async function ensureWorkerTab(rsid) {
    const isAlive = () => sget('worker_rsid', null) === rsid && Date.now() - sget('worker_alive_at', 0) < 6000;
    if (isAlive()) return;
    log('  Đang mở tab nền dùng chung cho lượt chạy (chỉ chờ 1 lần, các đơn sau sẽ nhanh)...');
    GM_openInTab(workerUrl(rsid), { active: false, insert: true });
    const t0 = Date.now();
    while (Date.now() - t0 < 55000) {
      if (isAlive()) return;
      await sleep(300);
    }
    throw new Error('Tab nền không phản hồi');
  }

  // Cách 1 (tab nền dùng chung cho cả lượt chạy): gửi yêu cầu tra 1 đơn cho tab nền, chờ nó báo
  // kết quả — không mở tab mới cho lần tra này (nếu tab nền đã sống từ trước).
  async function lookupViaWorker(code, opts, timeoutMs) {
    const rsid = sget('run_session_id', null);
    if (!rsid) throw new Error('Chưa có lượt chạy đang hoạt động');
    await ensureWorkerTab(rsid);
    const key = 'lookup_' + code;
    const openedAt = Date.now();
    GM_setValue(key, null);
    GM_setValue('lookup_opts_' + code, opts || {});
    GM_setValue('worker_nav_request', { code, rsid, t: Date.now() });
    return await waitForLookupResult(key, openedAt, timeoutMs, false);
  }

  // Cách 2 (dự phòng): mở tab riêng tới trang tra cứu cho ĐÚNG đơn này rồi đóng ngay
  // — chỉ dùng khi tab nền dùng chung không dùng được.
  async function lookupViaTab(code, timeoutMs) {
    const key = 'lookup_' + code;
    const openedAt = Date.now();
    GM_setValue(key, null);
    let tab = null;
    try {
      tab = GM_openInTab(lookupUrl(code), { active: false, insert: true });
      return await waitForLookupResult(key, openedAt, timeoutMs, true);
    } finally {
      try { if (tab) tab.close(); } catch (e) {}
    }
  }

  // ---- Lastmile (nhanh.ghn.vn): 1 tab nền dùng chung cho cả lượt chạy (xem Phần 1b) ----
  const lmWorkerUrl = (rsid) => 'https://nhanh.ghn.vn/lastmile?worker=1&rsid=' + encodeURIComponent(rsid);
  async function ensureLmWorker(rsid) {
    const isAlive = () => sget('lm_worker_rsid', null) === rsid && Date.now() - sget('lm_worker_alive_at', 0) < 8000;
    if (isAlive()) return;
    log('  Đang mở tab nền Lastmile (chỉ chờ 1 lần đầu lượt chạy)...');
    GM_openInTab(lmWorkerUrl(rsid), { active: false, insert: true });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (isAlive()) return;
      await sleep(300);
    }
    const err = new Error('Không mở được tab nền Lastmile — kiểm tra đã đăng nhập https://nhanh.ghn.vn (cùng trình duyệt) và đã cho Tampermonkey chạy trên trang này chưa.');
    err.fatal = true;
    throw err;
  }
  // Hỏi Lastmile: số tiền đã thu khi giao thất bại của 1 đơn, sau khi chọn đúng BC giao (bcId) ở góc phải.
  async function lookupLastmile(code, bcId) {
    const rsid = sget('run_session_id', null);
    if (!rsid) throw new Error('Chưa có lượt chạy đang hoạt động');
    await ensureLmWorker(rsid);
    const key = 'lm_result_' + code;
    const openedAt = Date.now();
    GM_setValue(key, null);
    GM_setValue('lm_request', { code, bc: bcId, rsid, t: Date.now() });
    const r = await waitForLookupResult(
      key, openedAt, 120000, true,
      'Lastmile không trả kết quả cho đơn ' + code + ' — kiểm tra tab nền Lastmile (đã đăng nhập chưa, có đúng BC ' + bcId + ' không).'
    );
    if (!r.ok) throw new Error(r.error || 'Tra cứu Lastmile thất bại');
    return r; // { ok, amount, amountText, bc }
  }

  async function lookupOrder(orderCode, opts) {
    // Báo cho trang tra cứu biết có cần đọc thêm "Lịch sử đơn hàng" hay không.
    GM_setValue('lookup_opts_' + orderCode, opts || {});
    const mode = sget('lookup_mode', 'frame');
    let r;
    if (mode === 'frame') {
      try {
        r = await lookupViaFrame(orderCode, 40000);
      } catch (e) {
        log('  Khung ẩn không trả kết quả (trình duyệt có thể đang chặn) — chuyển sang tab nền dùng chung.');
        await sset('lookup_mode', 'worker'); // các đơn sau trong lượt chạy này dùng luôn tab nền
        r = await lookupOrderViaWorkerThenTab(orderCode, opts);
      }
    } else if (mode === 'worker') {
      r = await lookupOrderViaWorkerThenTab(orderCode, opts);
    } else {
      r = await lookupViaTab(orderCode, 45000);
    }
    if (!r.ok) throw new Error(r.error || 'Tra cứu thất bại');
    return r; // { ok, vh, kh, lc, t }
  }

  async function lookupOrderViaWorkerThenTab(orderCode, opts) {
    try {
      return await lookupViaWorker(orderCode, opts, 40000);
    } catch (e) {
      log('  Tab nền dùng chung không phản hồi — chuyển sang mở tab riêng cho từng đơn.');
      await sset('lookup_mode', 'tab'); // các đơn sau trong lượt chạy này dùng luôn tab riêng
      return await lookupViaTab(orderCode, 45000);
    }
  }

  // ======================================================================
  // Tiện ích DOM
  // ======================================================================
  function waitFor(fn, { timeout = 15000, interval = 250 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const attempt = () => {
        let v = null;
        try { v = fn(); } catch (e) {}
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return reject(new Error(`Hết thời gian chờ (${timeout}ms)`));
        sleep(interval).then(attempt);
      };
      attempt();
    });
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return !!(r.width || r.height);
  }
  const visibleButtons = () => Array.from(document.querySelectorAll('button')).filter(isVisible);
  const findButtonByExactText = (text) => visibleButtons().find((b) => b.textContent.trim() === text) || null;

  function findLeavesMatching(regex) {
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length === 0 && regex.test(el.textContent.trim()) && isVisible(el)) out.push(el);
    });
    return out;
  }
  function findLeafByExactText(text) {
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length === 0 && el.textContent.trim() === text && isVisible(el)) return el;
    }
    return null;
  }

  // Gán giá trị theo cách React nhận biết được (native setter + sự kiện input).
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getVisibleModal() {
    const modals = Array.from(document.querySelectorAll('.ant-modal')).filter(isVisible);
    return modals[modals.length - 1] || null;
  }
  function closeVisibleModal() {
    const modal = getVisibleModal();
    if (!modal) return;
    const btn = modal.querySelector('.ant-modal-close') || document.querySelector('button[aria-label="Close"]');
    if (btn) btn.click();
  }

  // ======================================================================
  // Trang chi tiết phiếu
  // ======================================================================
  const getTicketCode = () => {
    const el = findLeavesMatching(/^\d{9,}$/)[0];
    return el ? el.textContent.trim() : location.pathname;
  };
  const isTicketConcluded = () => !!findLeafByExactText('Hoàn tất');

  function getTicketCreatedText() {
    const label = findLeafByExactText('Thời gian tạo phiếu');
    if (!label) return '';
    const leaves = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && isVisible(e));
    const i = leaves.indexOf(label);
    return i >= 0 && leaves[i + 1] ? leaves[i + 1].textContent.trim() : '';
  }

  async function waitDetailReady() {
    await waitFor(
      () =>
        (findButtonByExactText('Kết luận') || findLeafByExactText('Hoàn tất') || findLeafByExactText('Tiến trình xử lý')) &&
        findLeavesMatching(/^\d{9,}$/)[0],
      { timeout: 25000 }
    );
    await sleep(600);
  }

  async function getOrderCodes() {
    const link = await waitFor(() => findLeavesMatching(/^\d+\s*đơn$/)[0], { timeout: 15000 });
    link.click();
    await waitFor(() => getVisibleModal() && findLeafByExactText('Mã đơn'), { timeout: 10000 });
    const codeRegex = /^[A-Z0-9]{6,12}$/;
    let codes = [];
    try {
      await waitFor(
        () => {
          const modal = getVisibleModal();
          if (!modal) return false;
          const found = new Set();
          modal.querySelectorAll('*').forEach((el) => {
            if (el.children.length === 0 && codeRegex.test(el.textContent.trim())) found.add(el.textContent.trim());
          });
          if (found.size) { codes = Array.from(found); return true; }
          return false;
        },
        { timeout: 10000, interval: 300 }
      );
    } catch (e) {}
    closeVisibleModal();
    await waitFor(() => !getVisibleModal(), { timeout: 5000 }).catch(() => {});
    return codes;
  }

  // Bấm Kết luận -> Không truy thu -> ghi chú -> Xác nhận, rồi XÁC MINH phiếu đã
  // chuyển "Hoàn tất" (không tin vào việc "bấm xong là xong").
  async function concludeNoTruyThu(note) {
    const klBtn = await waitFor(() => findButtonByExactText('Kết luận'), { timeout: 10000 });
    klBtn.click();
    await waitFor(() => getVisibleModal() && document.querySelector('input[type="radio"][value="no_recovery"]'), { timeout: 10000 });
    await sleep(300);
    document.querySelector('input[type="radio"][value="no_recovery"]').click();
    await sleep(250);
    const ta = await waitFor(() => document.querySelector('textarea[placeholder="Nhập nội dung kết luận..."]'), { timeout: 8000 });
    setNativeValue(ta, note);
    await sleep(300);
    const confirmBtn = await waitFor(() => {
      const b = findButtonByExactText('Xác nhận');
      return b && !b.disabled ? b : null;
    }, { timeout: 10000 });
    confirmBtn.click();
    await waitFor(() => !getVisibleModal() || isTicketConcluded(), { timeout: 25000 });
    await waitFor(() => isTicketConcluded(), { timeout: 12000 }).catch(() => {
      throw new Error('Đã bấm Xác nhận nhưng chưa thấy phiếu chuyển "Hoàn tất" — hãy kiểm tra lại phiếu này bằng tay.');
    });
    await sleep(800);
  }

  // ======================================================================
  // Xử lý 1 phiếu theo rule
  // ======================================================================
  // Chỉ dựa vào "Trạng thái VẬN HÀNH" hiển thị trên trang tra cứu (không dựa
  // trạng thái khách hàng vì có lúc lệch thực tế). Khớp ĐÚNG chữ — các trạng
  // thái khác (kể cả "Hoàn tất" của đơn thất lạc...) đều là "other".
  const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const OPS_DELIVERED = normText('Đã giao hàng');
  const OPS_RETURNED = normText('Đã trả hàng');

  // Đơn "chỉ ở các trạng thái hoàn" theo đúng chữ Trạng thái VẬN HÀNH (không phải trạng thái
  // khách hàng): Đang luân chuyển trả, Lưu kho trả, Đang trả hàng, Đã trả hàng. "Lưu kho chờ
  // trả" (còn đang chờ xác nhận, chưa chắc hoàn) và "Hoàn tất" KHÔNG tính.
  const RETURN_GROUP_VH = ['đang luân chuyển trả', 'lưu kho trả', 'đang trả hàng', 'đã trả hàng'];
  function isReturnGroupVh(vh) {
    return RETURN_GROUP_VH.includes(normText(vh));
  }

  async function fetchOrderStatus(code, needHist, needFee) {
    const opts = {};
    if (needHist) opts.hist = true;
    if (needFee) { opts.fee = true; opts.feeIfReturnGroup = true; }
    const o = await lookupOrder(code, needHist || needFee ? opts : null);
    const vh = normText(o.vh);
    const status = vh === OPS_DELIVERED ? 'delivered' : vh === OPS_RETURNED ? 'returned' : 'other';
    log(`  ${code}: Vận hành: ${o.vh || '?'} | Khách hàng: ${o.kh || '?'} → ${status}`);
    if (o.fee) {
      log(`  ${code}: Tổng phí dịch vụ ${o.fee.totalText} − Phí khai giá ${o.fee.khaiGiaText} = ${fmtMoney(o.fee.total - o.fee.khaiGia)}`);
      log(`  ${code}: Giao thất bại - thu tiền: ${o.fee.gtbStatusText || '(không có dòng này)'}`);
    }
    const m = String(o.khoGiao || '').match(/^\s*(\d{4,})/);
    return { code, status, opsName: o.vh || '', vh: o.vh || '', history: o.history || null, fee: o.fee || null, bcGiao: m ? m[1] : '' };
  }

  // "10:34 27/08/2026" (giờ Việt Nam) -> mốc thời gian (ms), null nếu không đọc được
  function parseVNDateTime(text) {
    const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return Date.UTC(+m[5], +m[4] - 1, +m[3], +m[1] - 7, +m[2]);
  }

  // Rule "Quá hạn toàn trình": dựa vào TRẠNG THÁI VẬN HÀNH hiện tại của đơn — đúng chữ trên
  // trang tra cứu: Lưu kho chờ trả (= "Chờ xác nhận giao lại"), Đang luân chuyển trả, Lưu kho
  // trả, Đang trả hàng, Đã trả hàng — và TRƯỚC lúc tạo phiếu chưa có log hoàn/trả (không cần
  // log mới sau khi tạo phiếu). KHÔNG dựa Trạng thái khách hàng vì có lúc lệch thực tế.
  const QHTT_VH = ['lưu kho chờ trả', 'đang luân chuyển trả', 'lưu kho trả', 'đang trả hàng', 'đã trả hàng'];
  const isQhttVh = (vh) => QHTT_VH.includes(normText(vh));
  const RETURN_ACTION_RE = /hoàn|chờ xác nhận giao lại/i;
  const RETURN_STATUS_RE = /trả|hoàn/i;
  function noReturnLogBeforeCreation(history, createdTs) {
    if (createdTs == null) return { ok: false, reason: 'không đọc được "Thời gian tạo phiếu"' };
    if (!history) return { ok: false, reason: 'không đọc được lịch sử đơn hàng' };
    const returnBefore = history.find(
      (h) => h.ts <= createdTs && (RETURN_ACTION_RE.test(h.action) || (h.changes || []).some((c) => RETURN_STATUS_RE.test(c.to)))
    );
    if (returnBefore) return { ok: false, reason: 'trước lúc tạo phiếu đã có log hoàn/trả' };
    return { ok: true };
  }

  // Trạng thái giải trình của phiếu: overdue | pending | explained | unknown.
  // Có khối nào "quá hạn" -> overdue; không thì có khối "chưa" -> pending; tất cả "đã" -> explained.
  function getTicketExplainStatus() {
    const badges = findLeavesMatching(/^(đã giải trình|đã quá hạn giải trình|chưa giải trình)$/i).map((b) =>
      b.textContent.trim().toLowerCase()
    );
    if (!badges.length) return 'unknown';
    if (badges.includes('đã quá hạn giải trình')) return 'overdue';
    if (badges.includes('chưa giải trình')) return 'pending';
    if (badges.every((t) => t === 'đã giải trình')) return 'explained';
    return 'unknown';
  }

  const bodyHas = (t) => document.body.innerText.includes(t);

  // Comment + đổi người xử lý. Chạy lặp không sợ trùng: nếu comment/người xử lý đã có
  // sẵn thì bỏ qua bước đó; mỗi bước đều XÁC MINH kết quả hiện ra trên trang.
  async function commentAndReassign(comment, empId, empName) {
    if (!bodyHas(comment)) {
      const ta = await waitFor(() => document.querySelector('textarea[placeholder="Cập nhật thông tin xử lý"]'), { timeout: 10000 });
      setNativeValue(ta, comment);
      await sleep(300);
      const sendBtn = await waitFor(() => {
        const b = document.querySelector('button[aria-label="Gửi"]');
        return b && isVisible(b) && !b.disabled ? b : null;
      }, { timeout: 8000 });
      sendBtn.click();
      await waitFor(() => bodyHas(comment), { timeout: 15000 }).catch(() => {
        throw new Error('Đã bấm Gửi nhưng chưa thấy comment xuất hiện trong phiếu — hãy kiểm tra lại bằng tay.');
      });
      await sleep(800);
    }

    const label = `${empId} - ${empName}`;
    if (!bodyHas(label)) {
      const changeBtn = await waitFor(() => findButtonByExactText('Đổi người xử lý'), { timeout: 10000 });
      changeBtn.click();
      const search = await waitFor(() => {
        const inputs = Array.from(document.querySelectorAll('input.ant-select-input')).filter(isVisible);
        return inputs[inputs.length - 1] || null;
      }, { timeout: 10000 });
      setNativeValue(search, empId);
      const option = await waitFor(() => {
        const opts = Array.from(document.querySelectorAll('.ant-select-item-option')).filter(isVisible);
        return opts.find((o) => o.textContent.includes(empId)) || null;
      }, { timeout: 10000 }).catch(() => null);
      if (!option) throw new Error(`Không tìm thấy nhân viên "${label}" trong danh sách tìm kiếm.`);
      option.click();
      await sleep(300);
      const confirmBtn = await waitFor(() => {
        const b = findButtonByExactText('Xác nhận đổi');
        return b && !b.disabled ? b : null;
      }, { timeout: 10000 });
      confirmBtn.click();
      await waitFor(() => !getVisibleModal(), { timeout: 20000 });
      await waitFor(() => bodyHas(label), { timeout: 12000 }).catch(() => {
        throw new Error(`Đã bấm Xác nhận đổi nhưng chưa thấy người xử lý đổi thành "${label}" — hãy kiểm tra lại phiếu.`);
      });
      await sleep(800);
    }
  }

  async function processTicket(rule, dry) {
    await waitDetailReady();
    const ticketCode = getTicketCode();
    const base = { type: rule.label, ticketCode, url: location.href, createdAt: getTicketCreatedText(), orderCodes: '' };
    log(`[${ticketCode}] ${rule.label}`);

    if (isTicketConcluded()) {
      log(`[${ticketCode}] Phiếu đã Hoàn tất từ trước → bỏ qua.`);
      return { ...base, kind: 'already', result: 'Đã hoàn tất từ trước', detail: '' };
    }

    let codes = await getOrderCodes();
    if (!codes.length) { await sleep(1500); codes = await getOrderCodes(); }
    if (!codes.length) throw new Error('Không đọc được mã đơn của phiếu');
    base.orderCodes = codes.join('; ');
    log(`[${ticketCode}] Mã đơn: ${base.orderCodes}`);

    const needHist = rule.key === 'QHTT';
    const orders = [];
    // Phiếu "không giao/lấy/trả": chỉ khi phiếu đã QUÁ HẠN giải trình mới cần đọc cước (để điền vào comment).
    const explainSt = rule.key === 'SAI_SO_LAN' ? getTicketExplainStatus() : null;
    const needFee = explainSt === 'overdue';
    for (const c of codes) orders.push(await fetchOrderStatus(c, needHist, needFee));
    let detail = orders.map((o) => `${o.code}: ${o.status}${o.opsName ? ' (' + o.opsName + ')' : ''}`).join('; ');

    const concludeWith = async (note, why) => {
      if (dry) {
        log(`[${ticketCode}] (XEM TRƯỚC) Sẽ kết luận: Không truy thu — "${note}"`);
        return { ...base, kind: 'planned', result: `(Xem trước) Sẽ kết luận: Không truy thu — ${note}`, detail: why || detail };
      }
      await concludeNoTruyThu(note);
      log(`[${ticketCode}] ĐÃ kết luận: Không truy thu — "${note}"`);
      return { ...base, kind: 'concluded', result: `Đã kết luận: Không truy thu — ${note}`, detail: why || detail };
    };

    // (1) Giao thành công / trả thành công
    const notes = orders.map((o) => rule.concludeOn[o.status] || null);
    const uniqueNotes = Array.from(new Set(notes));
    if (notes.every(Boolean) && uniqueNotes.length === 1) return concludeWith(uniqueNotes[0]);

    // (2) Quá hạn toàn trình: trạng thái vận hành hiện tại thuộc nhóm hoàn/chờ giao lại và
    //     trước lúc tạo phiếu chưa có log hoàn/trả.
    if (rule.key === 'QHTT') {
      const createdTs = parseVNDateTime(base.createdAt);
      const notIn = orders.filter((o) => !isQhttVh(o.vh));
      if (notIn.length) {
        log(`  Trạng thái vận hành hiện tại không thuộc nhóm hoàn/trả (${notIn.map((o) => `${o.code}: ${o.vh || '?'}`).join('; ')}) → không áp rule này.`);
      } else {
        const checks = orders.map((o) => noReturnLogBeforeCreation(o.history, createdTs));
        checks.forEach((c, i) => log(`  ${orders[i].code}: "${orders[i].vh}" — ${c.ok ? 'trước lúc tạo phiếu chưa có log hoàn/trả' : 'không đạt — ' + c.reason}`));
        if (checks.every((c) => c.ok)) {
          return concludeWith(NOTE_NEW_LOG, `${detail} | trạng thái hoàn/chờ giao lại, trước lúc tạo phiếu chưa có log hoàn/trả`);
        }
      }
    }

    // (3) Không giao/lấy/trả đúng số lần: đơn chỉ ở trạng thái hoàn (đang luân chuyển trả / lưu kho trả / đang trả hàng / đã trả hàng) + phiếu quá hạn giải trình
    if (rule.key === 'SAI_SO_LAN' && orders.every((o) => isReturnGroupVh(o.vh))) {
      log(`[${ticketCode}] Đơn ở trạng thái hoàn — trạng thái giải trình: ${explainSt}`);
      if (explainSt === 'overdue') {
        // Có "phiếu thu GTB TT" hay không: xem CẢ tracuu lẫn Lastmile (2 hệ thống có lúc chưa đồng
        // bộ) — KHÔNG có khi cả 2 đều không có; CÓ khi tracuu HOẶC Lastmile báo đã thu.
        for (const o of orders) {
          const tcCollected = !!(o.fee && o.fee.gtbCollected === true);
          if (!tcCollected && !o.bcGiao) throw new Error(`Không đọc được ID BC giao ("Kho giao") của đơn ${o.code} ở tracuu để chọn BC trên Lastmile`);
          // tracuu đã báo "Đã thu" thì chắc chắn CÓ phiếu thu → khỏi mở Lastmile cho đơn này.
          o.lm = tcCollected ? null : await lookupLastmile(o.code, o.bcGiao);
          o.hasGtb = tcCollected || o.lm.amount > 0;
          log(
            `  ${o.code}: GTB TT — tracuu: ${o.fee && o.fee.gtbStatusText ? o.fee.gtbStatusText : 'không có'} | Lastmile: ${o.lm ? o.lm.amountText : '(không cần tra)'}` +
              ` → ${o.hasGtb ? 'CÓ phiếu thu' : 'KHÔNG có phiếu thu'}`
          );
        }
        const withGtb = orders.filter((o) => o.hasGtb);
        if (withGtb.length === 0) {
          // KHÔNG có phiếu thu GTB TT → comment + đổi người xử lý
          // Tổng cước đền bù = Σ (Tổng phí dịch vụ − Phí khai giá) của các đơn trong phiếu.
          let amount = 0;
          for (const o of orders) {
            if (!o.fee || o.fee.total == null || o.fee.khaiGia == null) {
              throw new Error(`Không đọc được cước của đơn ${o.code} để điền vào comment`);
            }
            amount += o.fee.total - o.fee.khaiGia;
          }
          if (!(amount > 0)) throw new Error(`Tổng cước đền bù tính ra ${amount} (không hợp lệ) — cần kiểm tra tay`);
          const comment = overdueComment(amount);
          const what = `Comment SLA (đền bù ${fmtMoney(amount)}) + chuyển người xử lý sang ${REASSIGN_ID} - ${REASSIGN_NAME}`;
          if (dry) {
            log(`[${ticketCode}] (XEM TRƯỚC) Sẽ: ${what}`);
            return { ...base, kind: 'planned', result: `(Xem trước) Sẽ: ${what}`, detail };
          }
          await commentAndReassign(comment, REASSIGN_ID, REASSIGN_NAME);
          log(`[${ticketCode}] ĐÃ: ${what}`);
          return { ...base, kind: 'reassigned', result: `Đã: ${what}`, detail };
        }
        // CÓ phiếu thu GTB TT (tracuu hoặc Lastmile) → CS theo dõi (rơi xuống kết quả mặc định bên dưới)
        detail += ` | có phiếu thu GTB TT (${withGtb.map((o) => o.code).join(', ')})`;
        log(`[${ticketCode}] Có phiếu thu GTB TT (${withGtb.map((o) => o.code).join(', ')}) → CS theo dõi.`);
      }
    }

    log(`[${ticketCode}] → ${rule.otherResult} (${detail})`);
    return { ...base, kind: 'manual', result: rule.otherResult, detail };
  }

  // ======================================================================
  // Danh sách phiếu (infinite-scroll) — đọc luôn loại phiếu ở cột 3
  // ======================================================================
  async function collectAllTickets() {
    await waitFor(() => document.querySelector('a[href*="/ghn-ticket/detail/"]'), { timeout: 20000 });
    let last = -1, stable = 0, rounds = 0;
    while (stable < 3 && rounds < 300) {
      const container = document.querySelector('.infinite-scroll-table__viewport');
      if (container) container.scrollTop = container.scrollHeight;
      else window.scrollBy(0, 900);
      await sleep(600);
      const count = document.querySelectorAll('a[href*="/ghn-ticket/detail/"]').length;
      if (count === last) stable++; else stable = 0;
      last = count;
      rounds++;
    }
    const map = new Map();
    document.querySelectorAll('a[href*="/ghn-ticket/detail/"]').forEach((a) => {
      const href = a.getAttribute('href');
      const m = href.match(/\/ghn-ticket\/detail\/(\d+)/);
      if (!m) return;
      const row = a.closest('tr');
      const cells = row ? row.querySelectorAll('td') : null;
      const typeLabel = cells && cells.length >= 3 ? (cells[2].getAttribute('title') || cells[2].textContent).trim() : '';
      map.set(m[1], { href, typeLabel });
    });
    return Array.from(map.entries());
  }

  // ======================================================================
  // Xuất kết quả CSV (mở bằng Excel)
  // ======================================================================
  const csvEscape = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function exportResults(auto) {
    const rows = sget('results', []);
    if (!rows.length) {
      log(auto ? 'Không có phiếu nào được xử lý trong lượt này — không xuất file.' : 'Chưa có kết quả để tải.');
      return;
    }
    const headers = ['Loại phiếu', 'Mã phiếu', 'Mã đơn', 'Thời gian tạo phiếu', 'Kết quả', 'Chi tiết', 'Link phiếu'];
    const lines = [headers.map(csvEscape).join(',')];
    rows.forEach((r) =>
      // Mã phiếu dạng ="691001820818" để Excel giữ nguyên số (không hiện 6.91E+11)
      lines.push([r.type, `="${r.ticketCode}"`, r.orderCodes, r.createdAt, r.result, r.detail, r.url].map(csvEscape).join(','))
    );
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `ghn_bot_ket_qua_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    log(`Đã xuất file "${filename}" (${rows.length} dòng).`);
  }

  // ======================================================================
  // Điều phối chạy xuyên qua các lần tải trang (mở phiếu = tải lại trang)
  // ======================================================================
  async function goToNextOrFinish() {
    if (!(await isRunActive())) return;
    const queue = sget('run_queue', []);
    if (!queue.length) {
      const rows = sget('results', []);
      const count = (k) => rows.filter((r) => r.kind === k).length;
      log(
        `=== HOÀN TẤT === Kết luận: ${count('concluded')} | Comment+chuyển người xử lý: ${count('reassigned')} | Xem trước: ${count('planned')} | ` +
          `CS theo dõi/check lại: ${count('manual')} | Đã xong từ trước: ${count('already')} | Lỗi: ${count('error')}`
      );
      await sset('run_active', false);
      await clearRunSession();
      exportResults(true);
      await sleep(1500);
      location.href = sget('run_list_url', ORIGIN + '/ghn-ticket');
      return;
    }
    const [id, href, type] = queue[0];
    await sset('run_queue', queue.slice(1));
    await sset('run_current_id', id);
    await sset('run_current_type', type);
    await sleep(400);
    location.href = ORIGIN + href;
  }

  let runStarting = false;
  async function startRun(dry, limit) {
    if (runStarting) return;
    runStarting = true;
    try {
      await sset('run_active', true);
      await sset('run_session_id', String(Date.now()));
      await sset('lookup_mode', 'frame'); // luôn thử lại khung ẩn (không hiện tab) ở mỗi lượt chạy mới
      await sset('run_dry', dry);
      await sset('run_list_url', location.href);
      await sset('results', []);
      await sset('hidden_warned', false);
      await sset('run_tab_id', getMyTabId());
      await sset('run_current_id', null);
      log(dry ? '=== BẮT ĐẦU — CHẾ ĐỘ XEM TRƯỚC (không thao tác) ===' : '=== BẮT ĐẦU — CHẠY THẬT ===');

      log('Đang quét danh sách phiếu (cuộn để lấy hết)...');
      let entries;
      try {
        entries = await collectAllTickets();
      } catch (e) {
        log('LỖI quét danh sách: ' + e.message);
        await sset('run_active', false);
        await clearRunSession();
        return;
      }
      const doneMap = sget('done_map', {});
      const byType = {};
      entries.forEach(([, info]) => {
        const k = info.typeLabel || '(không xác định)';
        byType[k] = (byType[k] || 0) + 1;
      });
      log(
        `Tìm thấy ${entries.length} phiếu: ` +
          Object.entries(byType).map(([k, v]) => `${k}${ruleByLabel(k) ? '' : ' [không thuộc phạm vi]'}: ${v}`).join(' | ')
      );

      let pending = entries
        .filter(([id, info]) => !doneMap[id] && ruleByLabel(info.typeLabel))
        .map(([id, info]) => [id, info.href, ruleByLabel(info.typeLabel).label]);
      log(`Sẽ xử lý ${pending.length} phiếu thuộc 3 loại đã có rule.`);
      if (limit && pending.length > limit) {
        pending = pending.slice(0, limit);
        log(`Giới hạn: chỉ chạy ${limit} phiếu đầu tiên.`);
      }
      await sset('run_queue', pending);
      await goToNextOrFinish();
    } finally {
      runStarting = false;
    }
  }

  async function stopRun() {
    await sset('run_active', false);
    await clearRunSession();
    log('Đã yêu cầu dừng — bot sẽ dừng sau khi xong phiếu đang xử lý.');
  }

  async function autoResumeIfNeeded() {
    if (!(await isRunActive())) return;
    const owner = sget('run_tab_id', null);
    const mine = getMyTabId();
    if (owner != null && mine != null && owner !== mine) return; // tab khác đang điều khiển lượt chạy

    const m = location.pathname.match(/\/ghn-ticket\/detail\/(\d+)/);
    const currentId = m ? m[1] : null;
    const expectedId = sget('run_current_id', null);
    if (expectedId && currentId !== expectedId) {
      log(`Cảnh báo: đang ở phiếu ${currentId} nhưng hàng đợi mong đợi ${expectedId} — tạm dừng để tránh xử lý sai.`);
      await sset('run_active', false);
      await clearRunSession();
      return;
    }

    if (document.hidden && !sget('hidden_warned', false)) {
      await sset('hidden_warned', true);
      log('Lưu ý: tab GHN đang ở nền — bot vẫn chạy nhưng có thể chậm hơn. Đừng thu nhỏ hoặc che kín hẳn cửa sổ GHN (che một phần thì không sao).');
    }
    const dry = sget('run_dry', true);
    const typeLabel = sget('run_current_type', null);
    const rule = ruleByLabel(typeLabel);

    let out;
    if (!rule) {
      log(`[${currentId}] Không có rule cho loại phiếu "${typeLabel}" → bỏ qua.`);
    } else {
      try {
        out = await processTicket(rule, dry);
      } catch (e) {
        log(`[${currentId}] LỖI: ${e.message} — sẽ thử lại ở lượt chạy sau.`);
        out = {
          kind: 'error', type: rule.label, ticketCode: getTicketCode(), orderCodes: '', createdAt: '',
          result: 'Lỗi (chưa xử lý được)', detail: e.message, url: location.href,
        };
        if (e.fatal) {
          const rows = sget('results', []);
          rows.push(out);
          await sset('results', rows);
          await sset('run_active', false);
          await clearRunSession();
          log('=== DỪNG LƯỢT CHẠY: không tra cứu được trạng thái đơn. Hãy khắc phục (đăng nhập tracuunoibo…) rồi bấm Bắt đầu lại. ===');
          return;
        }
      }
    }
    if (out) {
      const rows = sget('results', []);
      rows.push(out);
      await sset('results', rows);
      // Chỉ đánh dấu "xong" khi CHẠY THẬT và đã kết luận (hoặc phiếu đã hoàn tất từ trước).
      // Phiếu "CS theo dõi" / lỗi luôn được kiểm tra lại ở lượt sau (trạng thái đơn có thể đổi).
      if (!dry && currentId && (out.kind === 'concluded' || out.kind === 'reassigned' || out.kind === 'already')) {
        const dm = sget('done_map', {});
        dm[currentId] = true;
        await sset('done_map', dm);
      }
    }
    if (!(await isRunActive())) return;
    await goToNextOrFinish();
  }

  // ======================================================================
  // View đã lưu — lưu link view (bỏ mốc ngày để lần sau tự lấy khoảng ngày mới nhất)
  // ======================================================================
  // Chuẩn hoá link view: bỏ from_date/to_date (trang tự điền lại mặc định = 3 tháng
  // gần nhất), sắp xếp tham số để so sánh 2 link có cùng view hay không.
  function cleanUrl(u) {
    try {
      const x = new URL(u, ORIGIN);
      x.searchParams.delete('from_date');
      x.searchParams.delete('to_date');
      x.searchParams.sort();
      return x.origin + x.pathname.replace(/\/$/, '') + x.search;
    } catch (e) {
      return u;
    }
  }
  const getViews = () => sget('saved_views', []);
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderViewSelect() {
    if (!ui) return;
    const sel = ui.root.getElementById('viewsel');
    const views = getViews();
    sel.innerHTML =
      '<option value="">— Dùng trang hiện tại —</option>' +
      views.map((v, i) => `<option value="${i}">${escapeHtml(v.name)}</option>`).join('');
    const idx = views.findIndex((v) => v.url === sget('selected_view', ''));
    sel.value = idx >= 0 ? String(idx) : '';
  }

  // ======================================================================
  // Giao diện (Shadow DOM để không đụng CSS của trang)
  // ======================================================================
  function unmountPanel() {
    const old = document.getElementById(HOST_ID);
    if (old) old.remove();
    ui = null;
  }
  function unmountTrigger() {
    const old = document.getElementById(TRIGGER_ID);
    if (old) old.remove();
  }

  // Nút bấm để mở/đóng panel — mặc định KHÔNG tự xổ panel đầy đủ ra mỗi khi tải trang, tránh
  // gây rối cho CS khi chỉ đang xem phiếu bình thường (không dùng tool). Ở trang danh sách,
  // chèn thẳng vào cạnh nút "Xử lý phiếu CSKH", giao diện giống 1 nút bình thường của trang.
  // Không tìm thấy chỗ đó (VD trang chi tiết phiếu) thì dùng nút tròn nổi góc phải thay thế.
  function findCskhButton() {
    return Array.from(document.querySelectorAll('button, a')).find((el) => el.textContent.trim() === 'Xử lý phiếu CSKH') || null;
  }
  async function toggleCollapsed(mode) {
    const collapsed = !sget('panel_collapsed', true);
    await sset('panel_collapsed', collapsed);
    if (collapsed) unmountPanel();
    else mountPanel(mode);
  }
  function mountTrigger(mode) {
    unmountTrigger();
    const host = document.createElement('div');
    host.id = TRIGGER_ID;
    const cskhBtn = findCskhButton();
    if (cskhBtn && cskhBtn.parentElement) {
      host.dataset.placement = 'inline';
      host.style.cssText = 'all:initial;display:inline-flex;vertical-align:middle;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .btn{display:inline-flex;align-items:center;background:#fff;color:#333;
            border:1px solid #d9d9d9;border-radius:6px;padding:8px 16px;cursor:pointer;
            white-space:nowrap;user-select:none}
          .btn:hover{border-color:#f04e23;color:#f04e23}
        </style>
        <div class="btn" id="btn" title="Mở/đóng Ticket Bot">Ticket Bot</div>`;
      // Lấy đúng font (cỡ chữ/độ đậm/font family) của nút "Xử lý phiếu CSKH" để chữ bằng nhau.
      root.getElementById('btn').style.font = getComputedStyle(cskhBtn).font;
      cskhBtn.parentElement.insertBefore(host, cskhBtn);
      root.getElementById('btn').addEventListener('click', () => toggleCollapsed(mode));
    } else {
      host.dataset.placement = 'fallback';
      host.style.cssText = 'all:initial;position:fixed;top:80px;right:16px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .fab{background:#f04e23;color:#fff;padding:8px 14px;border-radius:999px;
            font:13px -apple-system,Segoe UI,Roboto,sans-serif;font-weight:600;cursor:pointer;
            box-shadow:0 4px 14px rgba(0,0,0,.25);white-space:nowrap;user-select:none}
          .fab:hover{filter:brightness(1.05)}
        </style>
        <div class="fab" id="fab" title="Mở/đóng Ticket Bot">🎫 Ticket Bot</div>`;
      document.documentElement.appendChild(host);
      root.getElementById('fab').addEventListener('click', () => toggleCollapsed(mode));
    }
  }

  // Panel đầy đủ (view đã lưu, nút Bắt đầu/Dừng, log...) — chỉ gắn khi đang mở (xem nút bấm ở
  // trên). Trạng thái đóng/mở được nhớ lại (GM storage) nên panel đang mở sẽ giữ nguyên mở qua
  // các lần tải trang khi bot đang tự chạy xuyên qua nhiều phiếu.
  function mountPanel(mode) {
    unmountPanel();
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:80px;right:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);

    root.innerHTML = `
      <style>
        .panel{width:360px;max-height:82vh;background:#fff;border:1px solid #ddd;border-radius:10px;
          box-shadow:0 4px 20px rgba(0,0,0,.18);font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#222;
          display:flex;flex-direction:column;overflow:hidden}
        .hd{background:#f04e23;color:#fff;padding:9px 12px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
        .hd span.min{cursor:pointer;padding:0 4px}
        .bd{padding:10px 12px;overflow:auto}
        label{display:flex;align-items:center;gap:6px;margin-bottom:8px}
        input[type=number]{width:90px;padding:4px;border:1px solid #ccc;border-radius:6px}
        .row{display:flex;gap:6px;margin-bottom:8px}
        button{flex:1;border:none;border-radius:6px;padding:6px;cursor:pointer;color:#fff;font:inherit}
        button:disabled{opacity:.45;cursor:not-allowed}
        .b-start{background:#f04e23}.b-stop{background:#888}.b-reset{background:#444}.b-csv{background:#2563eb}
        .b-save{background:#16a34a}.b-del{background:#999;flex:0 0 52px}
        .views{border-top:1px solid #eee;padding-top:8px;margin-bottom:8px}
        .sec{font-weight:600;margin-bottom:6px}
        select{width:100%;box-sizing:border-box;padding:5px;border:1px solid #ccc;border-radius:6px;margin-bottom:6px;font:inherit;background:#fff}
        .row input[type=text]{flex:1;min-width:0;padding:5px;border:1px solid #ccc;border-radius:6px;font:inherit}
        .hint{font-size:11px;color:#666;line-height:1.4;margin-bottom:6px}
        .rules{font-size:11px;color:#666;margin-bottom:8px;line-height:1.4}
        .log{background:#f7f7f7;border:1px solid #eee;border-radius:6px;padding:6px;height:240px;overflow:auto;
          white-space:pre-wrap;font:11px Consolas,monospace}
      </style>
      <div class="panel">
        <div class="hd"><span>Ticket Bot v${VERSION} ${mode === 'detail' ? '(đang ở phiếu)' : '(danh sách)'}</span><span class="min" id="min" title="Thu gọn thành icon">—</span></div>
        <div class="bd" id="bd">
          <div class="views">
            <div class="sec">View đã lưu</div>
            <select id="viewsel"></select>
            <div class="row">
              <input type="text" id="viewname" placeholder="Tên view (VD: Phiếu của tôi)">
              <button class="b-save" id="viewsave">Lưu view này</button>
              <button class="b-del" id="viewdel">Xoá</button>
            </div>
          </div>
          <label><input type="checkbox" id="dry"> Chế độ xem trước (không thao tác)</label>
          <label>Chỉ chạy <input type="number" id="limit" min="1" placeholder="để trống = hết"> phiếu đầu tiên</label>
          <div class="row">
            <button class="b-start" id="start" ${mode === 'detail' ? 'disabled' : ''}>Bắt đầu</button>
            <button class="b-stop" id="stop">Dừng</button>
            <button class="b-reset" id="reset">Reset đã xử lý</button>
          </div>
          <div class="row"><button class="b-csv" id="csv">Tải kết quả (CSV)</button></div>
          <div class="log" id="log"></div>
        </div>
      </div>`;

    ui = { host, root, logEl: root.getElementById('log') };
    root.getElementById('dry').checked = !!sget('run_dry', true);
    renderViewSelect();

    root.getElementById('min').addEventListener('click', () => toggleCollapsed(mode));

    root.getElementById('viewsel').addEventListener('change', async (e) => {
      const v = getViews()[parseInt(e.target.value, 10)];
      await sset('selected_view', v ? v.url : '');
    });
    root.getElementById('viewsave').addEventListener('click', async () => {
      if (getMode() !== 'list') {
        log('Hãy mở đúng view danh sách phiếu (không phải trang chi tiết) rồi mới bấm "Lưu view này".');
        return;
      }
      const nameInput = root.getElementById('viewname');
      const url = cleanUrl(location.href);
      const views = getViews().slice();
      const i = views.findIndex((v) => cleanUrl(v.url) === url);
      const name = nameInput.value.trim() || (i >= 0 ? views[i].name : `View ${views.length + 1}`);
      if (i >= 0) views[i] = { name, url };
      else views.push({ name, url });
      await sset('saved_views', views);
      await sset('selected_view', url);
      nameInput.value = '';
      renderViewSelect();
      log(`Đã lưu view "${name}".`);
    });
    root.getElementById('viewdel').addEventListener('click', async () => {
      const sel = root.getElementById('viewsel').value;
      if (sel === '') { log('Chưa chọn view nào để xoá.'); return; }
      const views = getViews().slice();
      const [gone] = views.splice(parseInt(sel, 10), 1);
      await sset('saved_views', views);
      await sset('selected_view', '');
      renderViewSelect();
      log(`Đã xoá view "${gone ? gone.name : ''}".`);
    });

    root.getElementById('start').addEventListener('click', async () => {
      const dry = root.getElementById('dry').checked;
      const n = parseInt(root.getElementById('limit').value, 10);
      const limit = Number.isFinite(n) && n > 0 ? n : null;
      const sel = root.getElementById('viewsel').value;
      const view = sel !== '' ? getViews()[parseInt(sel, 10)] : null;
      if (view) {
        await sset('selected_view', view.url);
        const target = cleanUrl(view.url);
        if (cleanUrl(location.href) !== target) {
          // Đang ở view khác → mở view đã chọn rồi tự bắt đầu ngay khi trang tải xong.
          await sset('pending_start', { dry, limit, url: target, t: Date.now() });
          log(`Đang mở view "${view.name}"...`);
          location.href = target;
          return;
        }
        log(`View: ${view.name}`);
      }
      startRun(dry, limit);
    });
    root.getElementById('stop').addEventListener('click', stopRun);
    root.getElementById('reset').addEventListener('click', async () => {
      await sset('done_map', {});
      log('Đã reset danh sách "đã xử lý".');
    });
    root.getElementById('csv').addEventListener('click', () => exportResults(false));
    renderLog();
  }

  // ======================================================================
  // Khởi động: theo dõi URL (trang SPA) để gắn/gỡ panel và tự tiếp tục lượt chạy
  // ======================================================================
  let currentMode = null;
  let resumedFor = null;
  function getMode() {
    const p = location.pathname;
    if (/^\/ghn-ticket\/detail\/\d+/.test(p)) return 'detail';
    if (/^\/ghn-ticket\/?$/.test(p)) return 'list';
    return null;
  }
  function tick() {
    const mode = getMode();
    currentMode = mode;
    if (mode) {
      // Nút bấm chỉ hiện ở trang danh sách — trang chi tiết phiếu thì KHÔNG hiện (CS mở từng
      // phiếu để xử lý bình thường không nên bị icon này làm phiền). Panel đầy đủ (nếu đang mở
      // từ trước, VD đang theo dõi 1 lượt chạy) vẫn hiện xuyên suốt cả 2 trang như cũ.
      if (mode === 'list') {
        // Trang SPA hay vẽ lại toolbar → kiểm tra mỗi giây, gắn lại nếu bị rớt khỏi trang. Nếu
        // đang ở dạng nổi dự phòng (lúc gắn nút chưa kịp thấy "Xử lý phiếu CSKH") mà giờ nút đó
        // đã xuất hiện thì nâng cấp lại thành nút chèn cạnh nó luôn, khỏi kẹt mãi ở dạng nổi.
        const trig = document.getElementById(TRIGGER_ID);
        const needRemount =
          !trig || !document.body.contains(trig) || (trig.dataset.placement === 'fallback' && findCskhButton());
        if (needRemount) mountTrigger(mode);
      } else {
        unmountTrigger();
      }
      const collapsed = sget('panel_collapsed', true);
      const panelEl = document.getElementById(HOST_ID);
      if (!collapsed && !panelEl) mountPanel(mode);
      if (collapsed && panelEl) unmountPanel();
    } else {
      unmountTrigger();
      unmountPanel();
    }
    if (mode === 'detail' && resumedFor !== location.pathname) {
      resumedFor = location.pathname;
      autoResumeIfNeeded().catch((e) => log('LỖI không mong đợi: ' + (e && e.message)));
    }
    if (mode !== 'detail') resumedFor = null;

    // Bắt đầu tự động sau khi đã mở view đã chọn (xem nút Bắt đầu).
    if (mode === 'list') {
      const p = sget('pending_start', null);
      if (p) {
        if (Date.now() - p.t > 120000) {
          sset('pending_start', null);
        } else if (cleanUrl(location.href) === p.url) {
          sset('pending_start', null);
          log('Đã mở view — bắt đầu chạy.');
          startRun(p.dry, p.limit);
        }
      }
    }
  }

  tick();
  setInterval(tick, 1000);
})();
