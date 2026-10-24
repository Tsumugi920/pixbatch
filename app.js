/* PixBatch —— 纯本地批量图片处理（无依赖、无构建、可直接 file:// 打开） */
(function () {
  'use strict';

  /* ================= 基础工具 ================= */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' t-' + type : '');
    el.textContent = msg;
    els.toastBox.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 320);
    }, 2600);
  }

  function triggerDownload(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ================= 原生 ZIP（STORE 方式，图片已压缩过，不再二次压缩） ================= */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xffffffff;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * 生成 ZIP（无压缩条目）。
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @returns {Blob}
   */
  function buildZip(entries) {
    if (entries.length > 0xffff) throw new Error('文件数量过多（超过 65535）');
    var enc = new TextEncoder();
    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    var parts = [];      // 本地文件头 + 数据
    var centrals = [];   // 中央目录
    var offset = 0;

    entries.forEach(function (e) {
      if (e.data.length >= 0xffffffff) throw new Error('单个文件超过 4GB，无法打包');
      var nameB = enc.encode(e.name);
      var crc = crc32(e.data);

      var local = new Uint8Array(30 + nameB.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);  // 本地文件头签名
      lv.setUint16(4, 20, true);          // 版本（2.0）
      lv.setUint16(6, 0x0800, true);      // 标志位：文件名为 UTF-8
      lv.setUint16(8, 0, true);           // 压缩方式 0 = STORE
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, e.data.length, true);
      lv.setUint32(22, e.data.length, true);
      lv.setUint16(26, nameB.length, true);
      local.set(nameB, 30);
      parts.push(local, e.data);

      var cd = new Uint8Array(46 + nameB.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);  // 中央目录头签名
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, e.data.length, true);
      cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(42, offset, true);     // 对应本地文件头的偏移
      cd.set(nameB, 46);
      centrals.push(cd);

      offset += local.length + e.data.length;
    });

    var cdSize = centrals.reduce(function (a, c) { return a + c.length; }, 0);
    if (offset + cdSize >= 0xffffffff) throw new Error('打包总大小超过 4GB');

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);    // 目录结束记录
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(parts.concat(centrals, [eocd]), { type: 'application/zip' });
  }

  /* ================= 常量与状态 ================= */

  var FORMAT = {
    jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
    webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
    png:  { mime: 'image/png',  ext: 'png',  label: 'PNG' }
  };
  var MAX_ITEMS = 1000;
  var ZIP_BTN_LABEL = '📦 打包下载 ZIP';

  var uid = 0;
  var state = { items: [], processing: false };
  var settingsDirty = false;
  var lastProcessedSig = null;   // 上次“全部处理”时的设置签名，用于判断结果是否过期

  var els = {};

  /* ================= 初始化 ================= */

  function canEncode(mime) {
    try {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      return c.toDataURL(mime).indexOf('data:' + mime) === 0;
    } catch (e) { return false; }
  }

  function grabEls() {
    els.dropzone = $('#dropzone');
    els.fileInput = $('#file-input');
    els.settingsPanel = $('#settings-panel');
    els.optWidth = $('#opt-width');
    els.optPercent = $('#opt-percent');
    els.format = $('#format');
    els.quality = $('#quality');
    els.qualityVal = $('#quality-val');
    els.pngNote = $('#png-note');
    els.renameToggle = $('#rename-toggle');
    els.renameFields = $('#rename-fields');
    els.prefix = $('#prefix');
    els.startNum = $('#start-num');
    els.pad = $('#pad');
    els.namePreview = $('#name-preview');
    els.btnProcess = $('#btn-process');
    els.btnZip = $('#btn-zip');
    els.btnClear = $('#btn-clear');
    els.progress = $('#progress');
    els.progressFill = $('#progress-fill');
    els.progressText = $('#progress-text');
    els.settingsHint = $('#settings-hint');
    els.list = $('#list');
    els.empty = $('#empty');
    els.summary = $('#summary');
    els.queueCount = $('#queue-count');
    els.queueTotal = $('#queue-total');
    els.toastBox = $('#toast-box');
  }

  function init() {
    grabEls();

    if (!canEncode('image/webp')) {
      var opt = els.format.querySelector('option[value="webp"]');
      opt.disabled = true;
      opt.textContent = 'WebP（当前浏览器不支持编码）';
    }

    bindEvents();
    updateQualityUi();
    updateNamePreview();
    render();
  }

  /* ================= 添加 / 移除图片 ================= */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var images = files.filter(function (f) {
      if (f.type && f.type.indexOf('image/') === 0) return true;
      return /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name);   // 兜底：部分环境拖入时 type 为空
    });
    var skipped = files.length - images.length;
    if (state.items.length + images.length > MAX_ITEMS) {
      images = images.slice(0, MAX_ITEMS - state.items.length);
      toast('队列最多 ' + MAX_ITEMS + ' 张，超出部分已忽略', 'error');
    }
    images.forEach(function (file) {
      var item = {
        id: ++uid,
        file: file,
        name: file.name,
        size: file.size,
        width: 0,
        height: 0,
        status: 'loading',   // loading | ready | processing | done | error
        error: null,
        result: null,        // { blob, url, size, width, height, name }
        thumbUrl: URL.createObjectURL(file)
      };
      state.items.push(item);
      loadMeta(item);
    });
    if (skipped > 0) toast('已跳过 ' + skipped + ' 个非图片文件', 'error');
    render();
  }

  function decode(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片解码失败（文件可能已损坏）')); };
      img.src = url;
    });
  }

  function loadMeta(item) {
    decode(item.thumbUrl).then(function (img) {
      item.width = img.naturalWidth;
      item.height = img.naturalHeight;
      item.status = item.status === 'loading' ? 'ready' : item.status;
      renderRow(item);
      refreshToolbar();
    }).catch(function (err) {
      item.status = 'error';
      item.error = err && err.message ? err.message : '无法读取图片';
      renderRow(item);
      refreshToolbar();
    });
  }

  function removeItem(id) {
    var idx = state.items.findIndex(function (i) { return i.id === id; });
    if (idx < 0) return;
    var it = state.items[idx];
    state.items.splice(idx, 1);
    releaseItem(it);
    render();
  }

  function clearAll() {
    if (!state.items.length || state.processing) return;
    if (!window.confirm('确定清空队列？已处理的临时结果会一并丢弃。')) return;
    state.items.forEach(releaseItem);
    state.items = [];
    settingsDirty = false;
    lastProcessedSig = null;
    render();
  }

  function releaseItem(it) {
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    if (it.result && it.result.url) URL.revokeObjectURL(it.result.url);
    it.result = null;
  }

  /* ================= 设置读取与输出命名 ================= */

  function readSettings() {
    var checked = $('input[name="scale-mode"]:checked');
    var padVal = els.pad.value;
    return {
      mode: checked ? checked.value : 'none',
      width: Math.round(Number(els.optWidth.value)),
      percent: Math.round(Number(els.optPercent.value)),
      format: els.format.value,
      quality: Number(els.quality.value) / 100,
      rename: els.renameToggle.checked,
      prefix: els.prefix.value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_'),
      startNum: Math.max(0, Math.round(Number(els.startNum.value) || 0)),
      pad: padVal === 'auto' ? 'auto' : Number(padVal)
    };
  }

  function validateSettings(s) {
    if (s.mode === 'width' && !(s.width >= 1 && s.width <= 20000)) return '请输入有效的输出宽度（1–20000 px）';
    if (s.mode === 'percent' && !(s.percent >= 1 && s.percent <= 500)) return '请输入有效的缩放比例（1%–500%）';
    return null;
  }

  function settingsSignature(s) {
    return [s.mode, s.width, s.percent, s.format, s.quality, s.rename, s.prefix, s.startNum, s.pad].join('|');
  }

  function padLength(s, count) {
    if (s.pad === 'auto') return Math.max(1, String(s.startNum + Math.max(count, 1) - 1).length);
    return s.pad;
  }

  /** 按当前设置为一批条目计算互不重名的输出文件名，返回 Map(id -> name) */
  function computeNames(items, s) {
    var ext = FORMAT[s.format].ext;
    var used = new Set();
    var names = new Map();
    if (s.rename) {
      var len = padLength(s, items.length);
      items.forEach(function (it, idx) {
        var base = s.prefix + String(s.startNum + idx).padStart(len, '0');
        var name = base + '.' + ext, n = 2;
        while (used.has(name)) name = base + '-' + (n++) + '.' + ext;
        used.add(name);
        names.set(it.id, name);
      });
    } else {
      items.forEach(function (it) {
        var base = it.name.replace(/\.[^.]+$/, '') || 'image';
        var name = base + '.' + ext, n = 2;
        while (used.has(name)) name = base + '-' + (n++) + '.' + ext;
        used.add(name);
        names.set(it.id, name);
      });
    }
    return names;
  }

  /* ================= 处理 ================= */

  function targetSize(ow, oh, s) {
    if (s.mode === 'width') {
      var tw = Math.max(1, Math.min(20000, s.width));
      return [tw, Math.max(1, Math.round(oh * tw / ow))];
    }
    if (s.mode === 'percent') {
      return [Math.max(1, Math.round(ow * s.percent / 100)), Math.max(1, Math.round(oh * s.percent / 100))];
    }
    return [ow, oh];
  }

  function processItem(item, s, outName) {
    return decode(item.thumbUrl).then(function (img) {
      var ow = img.naturalWidth, oh = img.naturalHeight;
      if (!ow || !oh) throw new Error('无法读取图片尺寸');

      var size = targetSize(ow, oh, s);
      var canvas = document.createElement('canvas');
      canvas.width = size[0];
      canvas.height = size[1];
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (s.format === 'jpeg') {          // JPEG 不支持透明，先垫白底
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          var fmt = FORMAT[s.format];
          if (!blob) return reject(new Error('编码失败'));
          if (blob.type !== fmt.mime) return reject(new Error('当前浏览器不支持 ' + fmt.label + ' 编码'));
          if (item.result && item.result.url) URL.revokeObjectURL(item.result.url);
          item.result = {
            blob: blob,
            url: URL.createObjectURL(blob),
            size: blob.size,
            width: canvas.width,
            height: canvas.height,
            name: outName
          };
          resolve();
        }, FORMAT[s.format].mime, s.quality);
      });
    });
  }

  function setProgress(cur, total) {
    els.progressFill.style.width = (total ? Math.round(cur / total * 100) : 0) + '%';
    els.progressText.textContent = '正在处理 ' + cur + ' / ' + total;
  }

  function processAll() {
    if (state.processing) return;
    if (state.items.some(function (i) { return i.status === 'loading'; })) {
      toast('仍有图片在读取中，请稍候再试', 'error');
      return;
    }
    var s = readSettings();
    var invalid = validateSettings(s);
    if (invalid) { toast(invalid, 'error'); return; }

    var targets = state.items.slice();
    if (!targets.length) return;
    var names = computeNames(targets, s);
    lastProcessedSig = settingsSignature(s);

    state.processing = true;
    settingsDirty = false;
    els.settingsHint.hidden = true;
    els.progress.hidden = false;
    setProgress(0, targets.length);
    render();

    var ok = 0, fail = 0;
    var chain = Promise.resolve();
    targets.forEach(function (it, i) {
      chain = chain.then(function () {
        if (state.items.indexOf(it) < 0) return;   // 处理过程中被移除
        it.status = 'processing';
        it.error = null;
        renderRow(it);
        setProgress(i + 1, targets.length);
        return processItem(it, s, names.get(it.id)).then(function () {
          it.status = 'done';
          ok++;
        }).catch(function (err) {
          it.status = 'error';
          it.error = (err && err.message) ? err.message : '处理失败';
          fail++;
        }).then(function () {
          if (state.items.indexOf(it) >= 0) renderRow(it);
        });
      });
    });

    chain.then(function () {
      state.processing = false;
      els.progress.hidden = true;
      render();
      toast(fail ? ('处理完成：成功 ' + ok + ' 张，失败 ' + fail + ' 张') : ('处理完成：共 ' + ok + ' 张'),
            fail ? 'error' : 'ok');
    });
  }

  /* ================= 下载 ================= */

  function downloadOne(id) {
    var it = state.items.find(function (i) { return i.id === id; });
    if (!it || !it.result) return;
    triggerDownload(it.result.url, it.result.name);
  }

  function downloadZip() {
    var done = state.items.filter(function (i) { return i.status === 'done' && i.result; });
    if (!done.length || state.processing) return;
    els.btnZip.disabled = true;
    els.btnZip.textContent = '打包中…';
    Promise.resolve().then(function () {
      var entries = done.map(function (it) {
        return it.result.blob.arrayBuffer().then(function (buf) {
          return { name: it.result.name, data: new Uint8Array(buf) };
        });
      });
      return Promise.all(entries);
    }).then(function (entries) {
      var zip = buildZip(entries);
      var url = URL.createObjectURL(zip);
      var stamp = new Date();
      var pad2 = function (n) { return String(n).padStart(2, '0'); };
      var stampStr = stamp.getFullYear() + pad2(stamp.getMonth() + 1) + pad2(stamp.getDate()) + '-' + pad2(stamp.getHours()) + pad2(stamp.getMinutes()) + pad2(stamp.getSeconds());
      triggerDownload(url, 'pixbatch-' + entries.length + 'pics-' + stampStr + '.zip');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      toast('已打包 ' + entries.length + ' 张图片', 'ok');
    }).catch(function (err) {
      toast((err && err.message) ? err.message : '打包失败', 'error');
    }).then(function () {
      els.btnZip.textContent = ZIP_BTN_LABEL;
      refreshToolbar();
    });
  }

  /* ================= 渲染 ================= */

  function rowHtml(it) {
    var status = '';
    if (it.status === 'loading') {
      status = '<span class="status st-loading">读取中…</span>';
    } else if (it.status === 'ready') {
      status = '<span class="status st-ready">待处理</span>';
    } else if (it.status === 'processing') {
      status = '<span class="status st-busy">处理中…</span>';
    } else if (it.status === 'error') {
      status = '<span class="status st-error">' + esc(it.error || '处理失败') + '</span>';
    } else if (it.status === 'done' && it.result) {
      var r = it.result;
      var save = it.size > 0 ? Math.round((1 - r.size / it.size) * 100) : 0;
      var saveHtml = save >= 0
        ? '<b class="save">节省 ' + save + '%</b>'
        : '<b class="save grow">体积 +' + (-save) + '%</b>';
      status = '<span class="status st-done">' + formatBytes(it.size) + ' → <b>' + formatBytes(r.size) +
               '</b> · ' + r.width + '×' + r.height + ' · ' + saveHtml + '</span>';
    }
    var nameHtml = esc(it.name);
    if (it.status === 'done' && it.result) nameHtml += ' → <span class="out">' + esc(it.result.name) + '</span>';
    var dims = it.width ? (it.width + ' × ' + it.height) : '…';
    var dlBtn = (it.status === 'done' && it.result)
      ? '<button class="btn sm" data-action="download" data-id="' + it.id + '">下载</button>'
      : '';
    return '<li class="item" data-id="' + it.id + '">' +
        '<img class="thumb" src="' + it.thumbUrl + '" alt="" loading="lazy">' +
        '<div class="info">' +
          '<div class="name" title="' + esc(it.name) + '">' + nameHtml + '</div>' +
          '<div class="dims">' + dims + ' · ' + formatBytes(it.size) + '</div>' +
          status +
        '</div>' +
        '<div class="actions">' + dlBtn +
          '<button class="icon-btn" data-action="remove" data-id="' + it.id + '" title="移除" aria-label="移除">✕</button>' +
        '</div>' +
      '</li>';
  }

  function renderRow(item) {
    if (!state.items.some(function (i) { return i.id === item.id; })) return;
    var li = els.list.querySelector('li[data-id="' + item.id + '"]');
    if (li) {
      var tmp = document.createElement('ul');
      tmp.innerHTML = rowHtml(item);
      li.replaceWith(tmp.firstChild);
    } else {
      renderList();
    }
  }

  function renderList() {
    els.list.innerHTML = state.items.map(rowHtml).join('');
    els.empty.hidden = state.items.length > 0;
  }

  function refreshToolbar() {
    var count = state.items.length;
    var done = state.items.filter(function (i) { return i.status === 'done' && i.result; });
    var processable = state.items.filter(function (i) { return i.status === 'ready' || i.status === 'done' || i.status === 'error'; });

    els.queueCount.textContent = '队列 ' + count + ' 张';
    var totalBytes = state.items.reduce(function (a, i) { return a + (i.size || 0); }, 0);
    els.queueTotal.textContent = count ? '共 ' + formatBytes(totalBytes) : '';

    els.btnProcess.disabled = state.processing || processable.length === 0;
    els.btnZip.disabled = state.processing || done.length === 0;
    els.btnClear.disabled = state.processing || count === 0;

    if (done.length) {
      var orig = done.reduce(function (a, i) { return a + i.size; }, 0);
      var out = done.reduce(function (a, i) { return a + i.result.size; }, 0);
      var save = orig > 0 ? Math.round((1 - out / orig) * 100) : 0;
      els.summary.hidden = false;
      els.summary.innerHTML = '已处理 <b>' + done.length + '</b> 张 · ' + formatBytes(orig) +
        ' → <b>' + formatBytes(out) + '</b> · 总体节省 <b>' + save + '%</b>';
    } else {
      els.summary.hidden = true;
    }
  }

  function render() {
    renderList();
    refreshToolbar();
  }

  /* ================= 设置区联动 ================= */

  function updateQualityUi() {
    var isPng = els.format.value === 'png';
    els.quality.disabled = isPng;
    els.qualityVal.textContent = els.quality.value;
    els.pngNote.hidden = !isPng;
  }

  function updateNamePreview() {
    var s = readSettings();
    var ext = FORMAT[s.format].ext;
    if (s.rename) {
      var len = padLength(s, Math.max(1, state.items.length));
      els.namePreview.textContent = s.prefix + String(s.startNum).padStart(len, '0') + '.' + ext;
    } else {
      els.namePreview.textContent = '原文件名.' + ext;
    }
  }

  function markSettingsChanged() {
    updateQualityUi();
    updateNamePreview();
    var anyDone = state.items.some(function (i) { return i.status === 'done'; });
    var changed = lastProcessedSig !== null && settingsSignature(readSettings()) !== lastProcessedSig;
    settingsDirty = anyDone && changed;
    els.settingsHint.hidden = !settingsDirty;
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    // 投放区：点击选择
    els.dropzone.addEventListener('click', function () { els.fileInput.click(); });
    els.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        els.fileInput.click();
      }
    });

    // 拖拽
    els.dropzone.addEventListener('dragover', function (e) {
      e.preventDefault();
      els.dropzone.classList.add('dragover');
    });
    els.dropzone.addEventListener('dragleave', function () {
      els.dropzone.classList.remove('dragover');
    });
    els.dropzone.addEventListener('drop', function (e) {
      e.preventDefault();
      els.dropzone.classList.remove('dragover');
      addFiles(e.dataTransfer.files);
    });
    // 防止拖漏到页面其他位置时浏览器直接打开图片
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    els.fileInput.addEventListener('change', function () {
      addFiles(els.fileInput.files);
      els.fileInput.value = '';   // 允许再次选择同一个文件
    });

    // 设置区联动
    els.settingsPanel.addEventListener('input', markSettingsChanged);
    els.settingsPanel.addEventListener('change', markSettingsChanged);
    els.renameToggle.addEventListener('change', function () {
      els.renameFields.hidden = !els.renameToggle.checked;
      markSettingsChanged();
    });

    // 工具栏
    els.btnProcess.addEventListener('click', processAll);
    els.btnZip.addEventListener('click', downloadZip);
    els.btnClear.addEventListener('click', clearAll);

    // 列表事件委托（整块 innerHTML 重建，必须委托）
    els.list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-id'));
      var action = btn.getAttribute('data-action');
      if (action === 'remove') removeItem(id);
      else if (action === 'download') downloadOne(id);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
