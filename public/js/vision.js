/* OpenVibe.Vision enhancement layer. Every form is complete without JavaScript; this only makes the drop zone
   accept a dragged file and shows the chosen filename. No result is fetched or rendered here. */
(function () {
    'use strict';
    if (!document.querySelectorAll) return;
    var zones = document.querySelectorAll('[data-vi-drop]');
    for (var i = 0; i < zones.length; i++) {
        (function (zone) {
            var input = zone.querySelector('input[type=file]');
            var name = zone.querySelector('[data-vi-file]');
            if (!input) return;
            function show() {
                var has = input.files && input.files.length;
                if (has) {
                    if (name) name.textContent = input.files[0].name;
                    zone.classList.add('is-chosen');
                } else {
                    if (name) name.textContent = '';
                    zone.classList.remove('is-chosen');
                }
            }
            input.addEventListener('change', show);
            function over(event) {
                event.preventDefault();
                event.stopPropagation();
                zone.classList.add('is-drag');
            }
            function out(event) {
                event.preventDefault();
                event.stopPropagation();
                zone.classList.remove('is-drag');
            }
            zone.addEventListener('dragenter', over);
            zone.addEventListener('dragover', over);
            zone.addEventListener('dragleave', out);
            zone.addEventListener('dragend', out);
            zone.addEventListener('drop', function (event) {
                over(event);
                zone.classList.remove('is-drag');
                var transfer = event.dataTransfer;
                if (!transfer || !transfer.files || !transfer.files.length) return;
                try {
                    input.files = transfer.files;
                    show();
                } catch (e) { /* older browsers keep the picker as the only way in */ }
            });
        })(zones[i]);
    }
})();
