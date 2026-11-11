/* Enhance Vision's native multipart inputs with the shared picker and progress. */
(function () {
    'use strict';
    if (!window.OVUpload || !window.DataTransfer) return;
    var maxBytes = Number(document.querySelector('meta[name="vision-image-max-bytes"]')?.content) || 8 * 1024 * 1024;
    var states = new WeakMap();
    var count = 0;

    document.querySelectorAll('form input[type="file"]').forEach(function (input) {
        var label = input.closest('label');
        var form = input.form;
        if (!label || !form) return;
        var root = document.createElement('div');
        var hint = document.createElement('p');
        var error = document.createElement('p');
        hint.className = 'vi-fine';
        hint.textContent = (input.accept === 'image/*' ? 'Images' : 'PNG, JPEG, WebP, GIF, BMP, TIFF or AVIF') + ' · up to ' + (maxBytes / 1024 / 1024) + ' MB.';
        hint.id = (input.id || 'vision-file-' + (++count)) + '-limit';
        error.setAttribute('role', 'alert');
        error.hidden = true;
        label.after(root, hint, error);
        var state = { file: null, row: null, meter: null, error: error };
        states.set(input, state);
        function clear() {
            state.file = null; state.row = null; input.value = '';
            if (state.meter) state.meter.destroy();
            state.meter = null;
        }
        var picker = OVUpload.picker(root, {
            label: label.querySelector('span')?.textContent || 'Choose an image',
            accept: input.accept, multiple: false, onRemove: clear,
            onFile: function (file, row) {
                if (state.row) { state.row.dispatchEvent(new Event('remove')); state.row.remove(); }
                error.hidden = true;
                var allowed = input.accept === 'image/*' ? /^image\//.test(file.type) : input.accept.split(',').includes(file.type);
                if (!allowed && !(file.type === '' && /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(file.name))) {
                    row.dispatchEvent(new Event('remove')); row.remove();
                    error.textContent = 'Choose a supported image file.'; error.hidden = false; return;
                }
                if (file.size > maxBytes) {
                    row.dispatchEvent(new Event('remove')); row.remove();
                    error.textContent = 'The image is larger than ' + (maxBytes / 1024 / 1024) + ' MB.'; error.hidden = false; return;
                }
                var transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
                state.file = file; state.row = row;
                var meterRoot = document.createElement('div'); row.append(meterRoot);
                state.meter = OVUpload.progress(meterRoot, { compact: true, onRetry: function () { send(form); } });
                state.meter.update({ state: 'waiting', total: file.size });
                if (input.hasAttribute('data-upload-auto')) form.requestSubmit();
            }
        });
        root.querySelector('.ov-upload__picker').setAttribute('aria-describedby', hint.id);
        root.addEventListener('paste', function (event) {
            if (event.clipboardData && event.clipboardData.files.length) { event.preventDefault(); picker.add(event.clipboardData.files); }
        });
        if (input.accept.startsWith('image/')) picker.input.setAttribute('capture', 'environment');
        input.required = false;
        input.hidden = true;
    });

    function send(form) {
        if (form.dataset.uploading === '1') return;
        var picked = Array.from(form.querySelectorAll('input[type="file"]')).map(function (input) { return states.get(input); }).filter(function (s) { return s && s.file; });
        if (!picked.length) return;
        form.dataset.uploading = '1';
        var buttons = Array.from(form.querySelectorAll('button[type="submit"]'));
        buttons.forEach(function (button) { button.disabled = true; });
        var total = picked.reduce(function (sum, s) { return sum + s.file.size; }, 0);
        var meter = picked[0].meter;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);
        xhr.upload.onprogress = function (event) {
            if (event.lengthComputable) meter.update({ state: 'sending', done: event.loaded, total: event.total });
        };
        xhr.upload.onload = function () { meter.update({ state: 'processing', done: total, total: total, message: 'Reading the image' }); };
        function retry(message) {
            form.dataset.uploading = '';
            buttons.forEach(function (button) { button.disabled = false; });
            meter.update({ state: 'failed', message: message });
        }
        xhr.onerror = function () { retry('The connection stopped. Try again.'); };
        xhr.onload = function () {
            if (xhr.status < 200 || xhr.status >= 400) {
                var page = new DOMParser().parseFromString(xhr.responseText || '', 'text/html');
                retry(page.querySelector('[role="alert"], h1')?.textContent || 'The image could not be sent. Try again.');
                return;
            }
            meter.update({ state: 'done', done: total, total: total });
            if (xhr.responseURL && new URL(xhr.responseURL).pathname + new URL(xhr.responseURL).search !== new URL(form.action).pathname + new URL(form.action).search) {
                window.location.assign(xhr.responseURL);
            } else {
                document.open(); document.write(xhr.responseText); document.close();
            }
        };
        meter.update({ state: 'sending', done: 0, total: total });
        xhr.send(new FormData(form));
    }
    document.querySelectorAll('form').forEach(function (form) {
        if (!form.querySelector('input[type="file"]')) return;
        form.addEventListener('submit', function (event) {
            var picked = Array.from(form.querySelectorAll('input[type="file"]')).some(function (input) { var s = states.get(input); return s && s.file; });
            if (!picked) return;
            event.preventDefault();
            send(form);
        });
    });
})();
