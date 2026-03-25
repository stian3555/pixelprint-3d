import * as THREE from 'three';
        import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
        import { LANG } from './i18n.js';
import { PROJECT_CFG_B64 } from './config.js';

        // ── CONSTANTS ────────────────────────────────────────────────────
        const GRID = 32;
        const CELL = 18;

        // ── STATE ────────────────────────────────────────────────────────
        let board        = Array.from({length: GRID}, () => Array(GRID).fill(null));
        let palette      = ['#E63946', '#457B9D', '#2A9D8F', '#E9C46A'];
        let activeColor  = 0;   // palette index, or -1 = erase
        let activeTool   = 'pencil'; // pencil | fill | rect | line
        let isDrawing    = false;
        let threejsReady = false;
        // Undo / redo
        let undoStack = [], redoStack = [], currentStroke = [], strokeSeen = new Set();
        // Shape tool state
        let shapeStart = null, previewCells = [];
        // Physical pixel size in mm (default 8mm → 32 px = 256mm = full bed)
        let pixelSizeX = 5;

        // ── DOM REFS ─────────────────────────────────────────────────────
        const boardEl       = document.getElementById('board');
        const swatchesEl    = document.getElementById('swatches');
        const colorPicker   = document.getElementById('color-picker');
        const statPixels    = document.getElementById('stat-pixels');
        const statColors    = document.getElementById('stat-colors');
        const nextBtn       = document.getElementById('next-btn');
        const clearBtn      = document.getElementById('clear-btn');
        const backBtn       = document.getElementById('back-btn');
        const exportBtn     = document.getElementById('export-btn');
        const saveArtBtn    = document.getElementById('save-art-btn');
        const saveDraftBtn  = document.getElementById('save-draft-btn');
        const loadBtn       = document.getElementById('load-btn');
        const fileInput     = document.getElementById('file-input');
        const thicknessEl   = document.getElementById('thickness');
        const thicknessVal  = document.getElementById('thickness-val');
        const previewPixels = document.getElementById('preview-pixels');
        const filamentList  = document.getElementById('filament-list');
        const step1Pill     = document.getElementById('step1-pill');
        const step2Pill     = document.getElementById('step2-pill');
        const screen1       = document.getElementById('screen-design');
        const screen2       = document.getElementById('screen-preview');
        const canvasWrap    = document.getElementById('canvas-wrap');
        const paletteBar    = document.querySelector('.palette-bar');

        // ── RESPONSIVE CELL SIZE ─────────────────────────────────────────
        function updateCellSize() {
            const pad = 48; // 24px each side
            const gap = 18; // gap between board and palette bar
            const availW = canvasWrap.clientWidth  - pad;
            const availH = canvasWrap.clientHeight - pad - paletteBar.offsetHeight - gap;
            const cell = Math.max(8, Math.floor(Math.min(availW, availH) / GRID));
            document.documentElement.style.setProperty('--cell', cell + 'px');
        }
        new ResizeObserver(updateCellSize).observe(canvasWrap);

        // ── KEYBOARD SHORTCUTS ───────────────────────────────────────────
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT') return;
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
                if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); redo(); return; }
            }
            if (e.key === 'b' || e.key === 'B') setTool('pencil');
            if (e.key === 'f' || e.key === 'F') setTool('fill');
            if (e.key === 'r' || e.key === 'R') setTool('rect');
            if (e.key === 'l' || e.key === 'L') setTool('line');
            if (e.key === '0') setActiveColor(-1);
            if (e.key >= '1' && e.key <= '4')  setActiveColor(+e.key - 1);
        });

        // ── TOOL MANAGEMENT ──────────────────────────────────────────────
        function setTool(t) {
            activeTool = t;
            clearPreview(); shapeStart = null;
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            const tbtn = document.getElementById('tool-' + t);
            if (tbtn) tbtn.classList.add('active');
            boardEl.style.cursor = t === 'fill' ? 'cell' : 'crosshair';
            buildSwatches();
        }

        document.getElementById('tool-pencil').addEventListener('click', () => setTool('pencil'));
        document.getElementById('tool-fill')  .addEventListener('click', () => setTool('fill'));
        document.getElementById('tool-rect')  .addEventListener('click', () => setTool('rect'));
        document.getElementById('tool-line')  .addEventListener('click', () => setTool('line'));
        document.getElementById('tool-undo')  .addEventListener('click', undo);
        document.getElementById('tool-redo')  .addEventListener('click', redo);

        // ── PALETTE ──────────────────────────────────────────────────────
        function buildSwatches() {
            swatchesEl.innerHTML = '';
            palette.forEach((c, i) => {
                const s = document.createElement('div');
                s.className = 'swatch' + (i === activeColor ? ' active' : '');
                s.style.background = c;
                s.title = t('swatchTitle', i+1);
                const badge = document.createElement('span');
                badge.className = 'swatch-num';
                badge.textContent = i + 1;
                s.appendChild(badge);
                s.addEventListener('click', () => setActiveColor(i));
                swatchesEl.appendChild(s);
            });
            // Eraser swatch
            const e = document.createElement('div');
            e.className = 'swatch swatch-eraser' + (activeColor === -1 ? ' active' : '');
            e.innerHTML = '<span class="swatch-num">0</span>';
            e.title = t('eraserTitle');
            e.addEventListener('click', () => setActiveColor(-1));
            swatchesEl.appendChild(e);

            colorPicker.value = palette[Math.max(0, activeColor)];
        }

        function setActiveColor(i) {
            activeColor = i;
            buildSwatches();
        }

        colorPicker.addEventListener('input', e => {
            const old = palette[activeColor];
            palette[activeColor] = e.target.value;
            // Repaint board cells that used the old color
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++)
                    if (board[y][x] === old) {
                        board[y][x] = e.target.value;
                        getCellEl(x, y).style.background = e.target.value;
                        if (threejsReady) cubes3d[y][x].material.color.set(e.target.value);
                    }
            buildSwatches();
            updateStats();
        });

        // ── BOARD INIT ───────────────────────────────────────────────────
        const cellEls = [];
        function getCellEl(x, y) { return cellEls[y * GRID + x]; }

        function buildBoard() {
            boardEl.innerHTML = '';
            cellEls.length = 0;
            for (let y = 0; y < GRID; y++) {
                for (let x = 0; x < GRID; x++) {
                    const c = document.createElement('div');
                    const cls = ['cell'];
                    if ((x + 1) % 4 === 0) cls.push('mx');
                    if ((y + 1) % 4 === 0) cls.push('my');
                    if (x === 15) cls.push('cx');
                    if (y === 15) cls.push('cy');
                    c.className = cls.join(' ');
                    c.addEventListener('mousedown', ev => {
                        ev.preventDefault(); isDrawing = true;
                        if (ev.button === 2) { setCell(x, y, null); return; }
                        if (activeTool === 'rect' || activeTool === 'line') {
                            shapeStart = {x, y};
                            if (activeTool === 'rect') showRectPreview(x, y, x, y);
                            else showLinePreview(x, y, x, y);
                        } else { paint(x, y); }
                    });
                    c.addEventListener('mouseenter', ev => {
                        if (!isDrawing) return;
                        if (ev.buttons === 2) { setCell(x, y, null); return; }
                        if (ev.buttons !== 1) return;
                        if (shapeStart && (activeTool === 'rect' || activeTool === 'line')) {
                            if (activeTool === 'rect') showRectPreview(shapeStart.x, shapeStart.y, x, y);
                            else showLinePreview(shapeStart.x, shapeStart.y, x, y);
                        } else { paint(x, y); }
                    });
                    c.addEventListener('dragstart', ev => ev.preventDefault());
                    boardEl.appendChild(c);
                    cellEls.push(c);
                }
            }
        }

        boardEl.addEventListener('contextmenu', e => e.preventDefault());

        window.addEventListener('mouseup', () => {
            if (isDrawing) {
                if (shapeStart && (activeTool === 'rect' || activeTool === 'line')) commitShape();
                else commitStroke();
                isDrawing = false;
            }
        });

        // ── PAINT ────────────────────────────────────────────────────────
        function paint(x, y) {
            if (activeTool === 'fill') { floodFill(x, y); return; }
            const isErase = activeColor === -1;
            const col     = isErase ? null : palette[activeColor];
            setCell(x, y, col);
        }

        function _applyCell(x, y, col) {
            board[y][x] = col;
            getCellEl(x, y).style.background = col ?? '#12121a';
            if (threejsReady) {
                cubes3d[y][x].visible = col !== null;
                if (col) cubes3d[y][x].material.color.set(col);
            }
        }

        function setCell(x, y, col) {
            const k = y * GRID + x;
            if (!strokeSeen.has(k)) { strokeSeen.add(k); currentStroke.push({x, y, from: board[y][x]}); }
            _applyCell(x, y, col);
            updateStats();
        }

        function commitStroke() {
            const changes = currentStroke
                .map(e => ({x: e.x, y: e.y, from: e.from, to: board[e.y][e.x]}))
                .filter(e => e.from !== e.to);
            if (changes.length) { undoStack.push(changes); if (undoStack.length > 100) undoStack.shift(); redoStack = []; }
            currentStroke = []; strokeSeen = new Set();
        }

        function undo() {
            if (!undoStack.length) return;
            const ch = undoStack.pop();
            ch.forEach(e => _applyCell(e.x, e.y, e.from));
            redoStack.push(ch);
            updateStats();
        }

        function redo() {
            if (!redoStack.length) return;
            const ch = redoStack.pop();
            ch.forEach(e => _applyCell(e.x, e.y, e.to));
            undoStack.push(ch);
            updateStats();
        }

        // ── SHAPE TOOLS (RECT / LINE) ─────────────────────────────────────────
        function clearPreview() {
            previewCells.forEach(({x, y}) => getCellEl(x, y).style.background = board[y][x] ?? '#12121a');
            previewCells = [];
        }

        function showRectPreview(x1, y1, x2, y2) {
            clearPreview();
            const col = activeColor === -1 ? '#12121a' : palette[activeColor];
            const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
            const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
            for (let y = minY; y <= maxY; y++)
                for (let x = minX; x <= maxX; x++) {
                    getCellEl(x, y).style.background = col;
                    previewCells.push({x, y});
                }
        }

        function showLinePreview(x1, y1, x2, y2) {
            clearPreview();
            const col = activeColor === -1 ? '#12121a' : palette[activeColor];
            bresenham(x1, y1, x2, y2).forEach(({x, y}) => {
                getCellEl(x, y).style.background = col;
                previewCells.push({x, y});
            });
        }

        function bresenham(x1, y1, x2, y2) {
            const pts = [];
            let dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
            let sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1, err = dx - dy;
            let x = x1, y = y1;
            for (;;) {
                pts.push({x, y});
                if (x === x2 && y === y2) break;
                const e2 = 2 * err;
                if (e2 > -dy) { err -= dy; x += sx; }
                if (e2 < dx)  { err += dx; y += sy; }
            }
            return pts;
        }

        function commitShape() {
            const col = activeColor === -1 ? null : palette[activeColor];
            const cells = [...previewCells];
            previewCells = []; shapeStart = null;
            cells.forEach(({x, y}) => setCell(x, y, col));
            commitStroke();
        }

        // ── FLOOD FILL ───────────────────────────────────────────────────
        function floodFill(sx, sy) {
            const fill   = activeColor === -1 ? null : palette[activeColor];
            const target = board[sy][sx];
            if (target === fill) return;
            const stack = [[sx, sy]];
            const visited = new Set();
            while (stack.length) {
                const [x, y] = stack.pop();
                if (x < 0 || x >= GRID || y < 0 || y >= GRID) continue;
                const key = y * GRID + x;
                if (visited.has(key)) continue;
                if (board[y][x] !== target) continue;
                visited.add(key);
                setCell(x, y, fill);
                stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
            }
        }

        // ── STATS ────────────────────────────────────────────────────────
        function autosave() {
            try {
                localStorage.setItem('pixelprint-state', JSON.stringify({
                    board, palette,
                    pixelSizeX,
                    thickness: parseFloat(document.getElementById('thickness').value),
                    projectName: document.getElementById('project-name').value,
                }));
            } catch(e) {}
        }

        function updateStats() {
            const counts = {};
            let total = 0;
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++)
                    if (board[y][x]) { counts[board[y][x]] = (counts[board[y][x]] || 0) + 1; total++; }

            statPixels.textContent = total;

            if (total === 0) {
                statColors.innerHTML = `<div style="font-size:12px;color:var(--text-dim)">${t('noArt')}</div>`;
            } else {
                statColors.innerHTML = '';
                palette.forEach((c, i) => {
                    if (!counts[c]) return;
                    const row = document.createElement('div');
                    row.className = 'color-chip';
                    row.innerHTML = `<div class="chip-dot" style="background:${c}"></div>
                        <span>${t('colorLabel', i+1)}</span>
                        <span class="chip-count">${counts[c]}px</span>`;
                    statColors.appendChild(row);
                });
            }
            autosave();
        }

        function updatePreviewStats() {
            const counts = {};
            let total = 0;
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++)
                    if (board[y][x]) { counts[board[y][x]] = (counts[board[y][x]] || 0) + 1; total++; }

            previewPixels.textContent = total;
            filamentList.innerHTML = '';
            palette.forEach((c, i) => {
                if (!counts[c]) return;
                const row = document.createElement('div');
                row.className = 'filament-row';
                row.innerHTML = `<div class="filament-dot" style="background:${c}"></div>
                    <span class="filament-slot">${t('amsSlot', i+1)}</span>
                    <span class="filament-px">${counts[c]} px</span>`;
                filamentList.appendChild(row);
            });
        }

        // ── CLEAR ────────────────────────────────────────────────────────
        clearBtn.addEventListener('click', () => {
            if (!confirm(t('confirmClear'))) return;
            board = Array.from({length: GRID}, () => Array(GRID).fill(null));
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++) {
                    getCellEl(x, y).style.background = '#12121a';
                    if (threejsReady) cubes3d[y][x].visible = false;
                }
            updateStats();
        });

        // ── NAVIGATION ───────────────────────────────────────────────────
        function goToPreview() {
            screen1.classList.remove('active');
            screen2.classList.add('active');
            step1Pill.className = 'step-pill done';
            step2Pill.className = 'step-pill active';
            if (!threejsReady) initThreejs();
            else rebuildScene();
            updatePreviewStats();
        }

        function goToDesign() {
            screen2.classList.remove('active');
            screen1.classList.add('active');
            step1Pill.className = 'step-pill active';
            step2Pill.className = 'step-pill inactive';
        }

        nextBtn.addEventListener('click', goToPreview);
        backBtn.addEventListener('click', goToDesign);
        step1Pill.addEventListener('click', () => { if (screen2.classList.contains('active')) goToDesign(); });
        step2Pill.addEventListener('click', () => { if (screen1.classList.contains('active')) goToPreview(); });

        // ── THICKNESS ────────────────────────────────────────────────────
        thicknessEl.addEventListener('input', e => {
            const th = parseFloat(e.target.value);
            thicknessVal.textContent = th.toFixed(1);
            if (threejsReady)
                for (let y = 0; y < GRID; y++)
                    for (let x = 0; x < GRID; x++)
                        cubes3d[y][x].scale.y = th;
        });

        // ── PIXEL SIZE ───────────────────────────────────────────────────
        function updateModelSizeLbl() {
            if (document.getElementById('model-size-lbl'))
                document.getElementById('model-size-lbl').textContent =
                    t('modelSize', pixelSizeX * GRID, pixelSizeX * GRID);
        }
        document.getElementById('px-size-x').addEventListener('input', e => {
            pixelSizeX = parseInt(e.target.value);
            document.getElementById('px-size-x-val').textContent = pixelSizeX;
            updateModelSizeLbl();
            if (threejsReady) rebuildScene();
        });

        document.getElementById('project-name').addEventListener('input', autosave);

        // ── THREE.JS ─────────────────────────────────────────────────────
        let scene, camera, renderer, controls, cubes3d, bedLine;

        function initThreejs() {
            const el = document.getElementById('container-3d');
            const W = el.clientWidth, H = el.clientHeight;

            scene    = new THREE.Scene();
            scene.background = new THREE.Color(0x080810);

            camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
            camera.position.set(0, 320, 400);
            camera.lookAt(0, 0, 0);

            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.setSize(W, H);
            el.appendChild(renderer.domElement);

            controls = new OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.06;

            scene.add(new THREE.AmbientLight(0xffffff, 0.65));
            const sun = new THREE.DirectionalLight(0xffffff, 0.7);
            sun.position.set(10, 50, 20);
            scene.add(sun);

            // Bed grid 256x256mm, 32 divisions (1 per pixel at 8mm default)
            const grid = new THREE.GridHelper(256, 32, 0x2a2a3e, 0x1a1a28);
            grid.position.y = -0.5;
            scene.add(grid);

            // Bed outline (256x256mm = always fixed size)
            {
                const hp = 128;
                const pts = new Float32Array([
                    -hp,0,-hp, hp,0,-hp,  hp,0,-hp, hp,0,hp,
                     hp,0, hp,-hp,0, hp, -hp,0, hp,-hp,0,-hp
                ]);
                const bg = new THREE.BufferGeometry();
                bg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
                bedLine = new THREE.LineSegments(bg,
                    new THREE.LineBasicMaterial({ color: 0x5050a0 }));
                bedLine.position.y = 0.5;
                scene.add(bedLine);
            }

            const geo = new THREE.BoxGeometry(1, 1, 1);
            geo.translate(0, 0.5, 0);

            cubes3d = Array.from({length: GRID}, (_, y) =>
                Array.from({length: GRID}, (_, x) => {
                    const mat  = new THREE.MeshStandardMaterial({ roughness: 0.45 });
                    const mesh = new THREE.Mesh(geo, mat);
                    mesh.position.set(
                        (x - GRID/2 + 0.5) * pixelSizeX,
                        0,
                        (y - GRID/2 + 0.5) * pixelSizeX
                    );
                    mesh.scale.set(pixelSizeX, parseFloat(thicknessEl.value), pixelSizeX);
                    mesh.visible = false;
                    scene.add(mesh);
                    return mesh;
                })
            );

            window.addEventListener('resize', () => {
                const W2 = el.clientWidth, H2 = el.clientHeight;
                camera.aspect = W2 / H2;
                camera.updateProjectionMatrix();
                renderer.setSize(W2, H2);
            });

            threejsReady = true;
            rebuildScene();

            (function animate() {
                requestAnimationFrame(animate);
                controls.update();
                renderer.render(scene, camera);
            })();
        }

        function rebuildScene() {
            const th = parseFloat(thicknessEl.value);
            for (let y = 0; y < GRID; y++) {
                for (let x = 0; x < GRID; x++) {
                    const col = board[y][x];
                    const mesh = cubes3d[y][x];
                    mesh.visible = col !== null;
                    mesh.scale.set(pixelSizeX, th, pixelSizeX);
                    mesh.position.set(
                        (x - GRID/2 + 0.5) * pixelSizeX, 0,
                        (y - GRID/2 + 0.5) * pixelSizeX
                    );
                    if (col) mesh.material.color.set(col);
                }
            }
        }

        // ── SAVE / LOAD PIXEL ART ─────────────────────────────────────────
        saveDraftBtn.addEventListener('click', saveArt);
        saveArtBtn  .addEventListener('click', saveArt);

        function fileName() {
            return (document.getElementById('project-name').value.trim() || 'pixelart')
                .replace(/[^a-zA-Z0-9_\-æøåÆØÅ ]/g, '').trim().replace(/ +/g, '_') || 'pixelart';
        }

        const PIXIL_COLORS = {"default":["000000","ffffff","f44336","e91e63","9c27b0","673ab7","3f51b5","2196f3","03a9f4","00bcd4","009688","4caf50","8bc34a","cddc39","ffeb3b","ffc107","ff9800","ff5722","795548","9e9e9e","607d8b"],"simple":["ffffff","d4d4d4","a1a1a1","787878","545454","303030","000000","edc5c5","e68383","ff0000","de2424","ad3636","823737","592b2b","f5d2ee","eb8dd7","f700b9","bf1f97","9c277f","732761","4f2445","e2bcf7","bf79e8","9d00ff","8330ba","6d3096","502c69","351b47","c5c3f0","736feb","0905f7","2e2eb0","2d2d80","252554","090936","c7e2ed","6ac3e6","00bbff","279ac4","347c96","2d5b6b","103947","bbf0d9","6febb3","00ff88","2eb878","349166","2b694c","0c3d25","c2edc0","76ed70","0dff00","36c72c","408c3b","315c2e","144511","d6edbb","b5eb73","8cff00","89c93a","6f8f44","4b632a","2a400c","f1f2bf","eef069","ffff00","baba30","91913f","5e5e2b","3b3b09","ffdeb8","f2ae61","ff8400","c48037","85623d","573e25","3d2309","fcbbae","ff8066","ff2b00","cc553d","9c5b4e","61372e","36130b"],"common":["000000","ffffff","464646","b4b4b4","990030","9c5a3c","ed1c24","ffa3b1","ff7e00","e5aa7a","ffc20e","f5e49c","fff200","fff9bd","a8e61d","d3f9bc","22b14c","00b7ef","99d9ea","4d6df3","709ad1","2f3699","546d8e","6f3198","b5a5d5"],"skin tones":["ffe0bd","ffdbac","ffcd94","eac086","e0ac69","f1c27d","ffad60","c68642","8d5524","896347","765339","613d24","4c2d17","391e0b","351606","2d1304","180a01","090300"]};

        function saveArt() {
            const offscreen = document.createElement('canvas');
            offscreen.width = GRID; offscreen.height = GRID;
            const ctx = offscreen.getContext('2d');
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++)
                    if (board[y][x]) { ctx.fillStyle = board[y][x]; ctx.fillRect(x, y, 1, 1); }
            offscreen.toBlob(pngBlob => {
                const fr = new FileReader();
                fr.onload = ev => {
                    const base64 = ev.target.result.split(',')[1];
                    const src = 'data:image/pngp98kjasdnasd983/24kasdjasdbase64,' + base64;
                    const now = Date.now();
                    const unqid = Math.random().toString(36).slice(2, 7);
                    const pixil = {
                        application: 'pixil', type: '.pixil', version: '2.7.0',
                        website: 'pixelprint-3d.stian.cloud',
                        author: 'https://pixelprint-3d.stian.cloud',
                        contact: 'https://github.com/stian3555/pixelprint-3d',
                        width: GRID, height: GRID,
                        colors: PIXIL_COLORS,
                        colorSelected: 'common',
                        frames: [{ name: '', speed: 100, layers: [{
                            id: 0, src, edit: false, name: 'Background', opacity: 1,
                            active: true, unqid: 'unic5a',
                            options: { blend: 'source-over', alpha_lock: false, locked: false,
                                filter: { brightness:'100%', contrast:'100%', grayscale:'0%',
                                    blur: 0, 'hue-rotate': 0, dropshadow_x: 0, dropshadow_y: 0,
                                    dropshadow_blur: 0, dropshadow_alpha: 1, dropshadow_color: '#000000' }
                            }
                        }], active: true, selectedLayer: 0, unqid, preview: src, previewApp: '', width: GRID, height: GRID }],
                        currentFrame: 0, speed: 100,
                        name: document.getElementById('project-name').value.trim() || 'pixelart',
                        preview: src, previewApp: '',
                        art_edit_id: 0, palette_id: false,
                        created_at: now, updated_at: now, id: now,
                    };
                    saveAs(new Blob([JSON.stringify(pixil)], {type: 'application/json'}), fileName() + '.pixil');
                };
                fr.readAsDataURL(pngBlob);
            });
        }

        loadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            fileInput.value = '';
            if (file.name.endsWith('.pixil')) {
                const reader = new FileReader();
                reader.onload = ev => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        if (data.application !== 'pixil' || !data.frames?.[0]?.layers?.length)
                            throw new Error(t('invalidFile'));
                        importPixil(data);
                    } catch(err) { alert(t('loadError') + err.message); }
                };
                reader.readAsText(file);
            } else if (file.type.startsWith('image/')) {
                importPng(file);
            } else {
                // Legacy .json format
                const reader = new FileReader();
                reader.onload = ev => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        if (!data.board || !data.palette) throw new Error(t('invalidFile'));
                        palette = data.palette; board = data.board;
                        undoStack = []; redoStack = [];
                        for (let y = 0; y < GRID; y++)
                            for (let x = 0; x < GRID; x++) {
                                const col = board[y][x];
                                getCellEl(x, y).style.background = col ?? '#12121a';
                                if (threejsReady) { cubes3d[y][x].visible = col !== null; if (col) cubes3d[y][x].material.color.set(col); }
                            }
                        buildSwatches(); updateStats();
                    } catch(err) { alert(t('loadError') + err.message); }
                };
                reader.readAsText(file);
            }
        });

        // ── EXPORT 3MF ───────────────────────────────────────────────────
        exportBtn.addEventListener('click', () => {
            exportBtn.textContent = t('generating');
            exportBtn.disabled = true;
            setTimeout(generate3MF, 80);
        });

        function resetExportBtn() {
            exportBtn.innerHTML = '⬇️ Last ned .3MF';
            exportBtn.disabled = false;
        }

        function generate3MF() {
            // Base64-encoded project_settings.config (full Bambu Studio profile)
            // Only filament_colour is patched with the real palette at export time.

            if (typeof JSZip === 'undefined') {
                alert('JSZip failed to load.');
                resetExportBtn();
                return;
            }

            const zip       = new JSZip();
            const thickness = parseFloat(thicknessEl.value);

            // Group pixels by palette slot order
            const colorGroups = [];
            for (let i = 0; i < palette.length; i++) {
                const c = palette[i];
                const pixels = [];
                for (let y = 0; y < GRID; y++)
                    for (let x = 0; x < GRID; x++)
                        if (board[y][x] === c) pixels.push({x, y});
                if (pixels.length > 0) colorGroups.push({colorIndex: i, color: c, pixels});
            }

            if (colorGroups.length === 0) {
                alert(t('emptyBoard'));
                resetExportBtn();
                return;
            }

            // UUID generator
            let _uid = 0;
            const nextUUID = () => (++_uid).toString(16).padStart(8,'0') + '-0000-4000-8000-000000000000';

            // [Content_Types].xml
            zip.file('[Content_Types].xml',
                '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
                ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
                ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
                ' <Default Extension="png" ContentType="image/png"/>\n' +
                '</Types>');

            // _rels/.rels
            zip.folder('_rels').file('.rels',
                '<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
                ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />\n' +
                '</Relationships>');

            // 3D/_rels/3dmodel.model.rels
            zip.folder('3D/_rels').file('3dmodel.model.rels',
                '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
                ' <Relationship Target="/3D/Objects/objects.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
                '</Relationships>');

            // 3D/Objects/objects.model — all geometry
            let objXml =
                '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<model unit="millimeter" xml:lang="en-US"' +
                ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"' +
                ' xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"' +
                ' xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"' +
                ' requiredextensions="p">\n' +
                ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
                ' <resources>\n';

            colorGroups.forEach((group, idx) => {
                const uuid = nextUUID();
                let vXml = '', tXml = '', vOff = 0;
                group.pixels.forEach(p => {
                    const px = (p.x - GRID/2) * pixelSizeX, py = (p.y - GRID/2) * pixelSizeX;
                    const pw = pixelSizeX, ph = pixelSizeX;
                    vXml += `     <vertex x="${px}" y="${py}" z="0"/>\n`;
                    vXml += `     <vertex x="${px+pw}" y="${py}" z="0"/>\n`;
                    vXml += `     <vertex x="${px+pw}" y="${py+ph}" z="0"/>\n`;
                    vXml += `     <vertex x="${px}" y="${py+ph}" z="0"/>\n`;
                    vXml += `     <vertex x="${px}" y="${py}" z="${thickness}"/>\n`;
                    vXml += `     <vertex x="${px+pw}" y="${py}" z="${thickness}"/>\n`;
                    vXml += `     <vertex x="${px+pw}" y="${py+ph}" z="${thickness}"/>\n`;
                    vXml += `     <vertex x="${px}" y="${py+ph}" z="${thickness}"/>\n`;
                    tXml += `     <triangle v1="${vOff}" v2="${vOff+2}" v3="${vOff+1}"/>\n`;
                    tXml += `     <triangle v1="${vOff}" v2="${vOff+3}" v3="${vOff+2}"/>\n`;
                    tXml += `     <triangle v1="${vOff+4}" v2="${vOff+5}" v3="${vOff+6}"/>\n`;
                    tXml += `     <triangle v1="${vOff+4}" v2="${vOff+6}" v3="${vOff+7}"/>\n`;
                    tXml += `     <triangle v1="${vOff}" v2="${vOff+1}" v3="${vOff+5}"/>\n`;
                    tXml += `     <triangle v1="${vOff}" v2="${vOff+5}" v3="${vOff+4}"/>\n`;
                    tXml += `     <triangle v1="${vOff+1}" v2="${vOff+2}" v3="${vOff+6}"/>\n`;
                    tXml += `     <triangle v1="${vOff+1}" v2="${vOff+6}" v3="${vOff+5}"/>\n`;
                    tXml += `     <triangle v1="${vOff+2}" v2="${vOff+3}" v3="${vOff+7}"/>\n`;
                    tXml += `     <triangle v1="${vOff+2}" v2="${vOff+7}" v3="${vOff+6}"/>\n`;
                    tXml += `     <triangle v1="${vOff+3}" v2="${vOff}" v3="${vOff+4}"/>\n`;
                    tXml += `     <triangle v1="${vOff+3}" v2="${vOff+4}" v3="${vOff+7}"/>\n`;
                    vOff += 8;
                });
                objXml +=
                    `  <object id="${idx+1}" p:UUID="${uuid}" type="model">\n` +
                    `   <mesh>\n    <vertices>\n${vXml}    </vertices>\n    <triangles>\n${tXml}    </triangles>\n   </mesh>\n  </object>\n`;
            });
            objXml += ' </resources>\n <build/>\n</model>';
            zip.folder('3D/Objects').file('objects.model', objXml);

            // 3D/3dmodel.model — assembly
            const asmId       = colorGroups.length + 1;
            const asmUUID     = nextUUID();
            const buildUUID   = nextUUID();
            let mainXml =
                '<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' +
                '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"' +
                ' xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"' +
                ' unit="millimeter" xml:lang="en-US" requiredextensions="p"' +
                ' xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n' +
                ' <metadata name="Application">BambuStudio-02.05.00.66</metadata>\n' +
                ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
                ' <resources>\n' +
                `  <object id="${asmId}" p:UUID="${asmUUID}" type="model">\n` +
                '   <components>\n';
            colorGroups.forEach((g, idx) =>
                mainXml += `    <component p:path="/3D/Objects/objects.model" objectid="${idx+1}" p:UUID="${nextUUID()}" transform="1 0 0 0 1 0 0 0 1 0 0 0" />\n`
            );
            mainXml +=
                '   </components>\n  </object>\n </resources>\n' +
                ` <build p:UUID="${buildUUID}">\n` +
                `  <item objectid="${asmId}" p:UUID="${nextUUID()}" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1" />\n` +
                ' </build>\n</model>';
            zip.folder('3D').file('3dmodel.model', mainXml);

            // Metadata/model_settings.config
            const totalFaces = colorGroups.reduce((s, g) => s + g.pixels.length * 12, 0);
            let cfgXml =
                '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
                `  <object id="${asmId}">\n` +
                '    <metadata key="name" value="PixelArt"/>\n' +
                '    <metadata key="extruder" value="1"/>\n' +
                `    <metadata face_count="${totalFaces}"/>\n`;
            colorGroups.forEach((g, idx) => {
                const ext  = g.colorIndex + 1;
                const fc   = g.pixels.length * 12;
                cfgXml +=
                    `    <part id="${idx+1}" subtype="normal_part">\n` +
                    `      <metadata key="name" value="Color${ext}"/>\n` +
                    `      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
                    `      <metadata key="source_object_id" value="${idx+1}"/>\n` +
                    `      <metadata key="source_volume_id" value="0"/>\n` +
                    `      <metadata key="extruder" value="${ext}"/>\n` +
                    `      <mesh_stat face_count="${fc}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n` +
                    `    </part>\n`;
            });
            cfgXml +=
                '  </object>\n  <plate>\n' +
                '    <metadata key="plater_id" value="1"/>\n' +
                '    <metadata key="plater_name" value=""/>\n' +
                '    <metadata key="locked" value="false"/>\n' +
                '    <model_instance>\n' +
                `      <metadata key="object_id" value="${asmId}"/>\n` +
                '      <metadata key="instance_id" value="0"/>\n' +
                '      <metadata key="identify_id" value="1"/>\n' +
                '    </model_instance>\n  </plate>\n' +
                `  <assemble>\n   <assemble_item object_id="${asmId}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 128 128 0" offset="0 0 0" />\n  </assemble>\n` +
                '</config>';
            zip.folder('Metadata').file('model_settings.config', cfgXml);

            // Metadata/slice_info.config
            zip.folder('Metadata').file('slice_info.config',
                '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n' +
                '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
                '    <header_item key="X-BBL-Client-Version" value="02.05.00.66"/>\n' +
                '  </header>\n</config>');

            // Metadata/cut_information.xml
            let cutXml = '<?xml version="1.0" encoding="utf-8"?>\n<objects>\n';
            colorGroups.forEach((g, idx) =>
                cutXml += ` <object id="${idx+1}">\n  <cut_id id="0" check_sum="1" connectors_cnt="0"/>\n </object>\n`);
            zip.folder('Metadata').file('cut_information.xml', cutXml + '</objects>');

            // Metadata/filament_sequence.json
            zip.folder('Metadata').file('filament_sequence.json',
                JSON.stringify({plate_1: {sequence: []}}));

            // Metadata/project_settings.config — extend to palette.length slots, patch colours
            try {
                const cfg = JSON.parse(atob(PROJECT_CFG_B64));
                // Only these keys are per-filament arrays (not coef/hole/limit arrays)
                // Template already has 4 slots — just patch the colours
                const slots = cfg['filament_colour'].length;
                for (let i = 0; i < Math.min(palette.length, slots); i++) {
                    cfg['filament_colour'][i] = palette[i].toUpperCase();
                    if (cfg['filament_multi_colour'])
                        cfg['filament_multi_colour'][i] = palette[i].toUpperCase();
                }
                zip.folder('Metadata').file('project_settings.config', JSON.stringify(cfg, null, 4));
            } catch(e) {
                console.warn('project_settings.config feil:', e);
            }

            zip.generateAsync({type: 'blob'}).then(blob => {
                const name = (document.getElementById('project-name').value.trim() || 'pixelart')
                    .replace(/[^a-zA-Z0-9_\-æøåÆØÅ ]/g, '').trim().replace(/ +/g, '_') || 'pixelart';
                saveAs(blob, name + '.3mf');
                resetExportBtn();
            });
        }

        // ── i18n ─────────────────────────────────────────────────────────
        

        let currentLang = localStorage.getItem('pixelprint-lang') || 'en';

        function t(key, ...args) {
            const val = LANG[currentLang][key];
            return typeof val === 'function' ? val(...args) : (val ?? key);
        }

        function applyLang() {
            document.getElementById('step1-pill').innerHTML = '<span class="step-num">1</span> ' + t('step1');
            document.getElementById('step2-pill').innerHTML = '<span class="step-num">2</span> ' + t('step2');
            document.getElementById('load-btn').textContent            = t('load');
            document.getElementById('save-draft-btn').textContent      = t('save');
            document.getElementById('tool-pencil').title               = t('toolPencil');
            document.getElementById('tool-fill').title                 = t('toolFill');
            document.getElementById('palette-label').textContent       = t('paletteLabel');
            document.getElementById('color-picker').title              = t('colorPickerTip');
            document.getElementById('title-pixels').textContent        = t('titlePixels');
            document.getElementById('pixels-drawn-label').textContent  = t('pixelsDrawn');
            document.getElementById('title-colors').textContent        = t('titleColors');
            document.getElementById('next-btn').textContent            = t('nextBtn');
            document.getElementById('clear-btn').textContent           = t('clearBtn');
            document.getElementById('orbit-hint').textContent          = t('orbitHint');
            document.getElementById('preview-heading').textContent     = t('previewHeading');
            document.getElementById('preview-sub').textContent         = t('previewSub');
            document.getElementById('title-thickness').textContent     = t('titleThickness');
            document.getElementById('range-label').textContent         = t('rangeLabel');
            document.getElementById('stat-lbl').textContent            = t('statLbl');
            document.getElementById('title-dist').textContent          = t('titleDist');
            document.getElementById('export-btn').textContent          = t('exportBtn');
            document.getElementById('save-art-btn').textContent        = t('saveArtBtn');
            document.getElementById('back-btn').textContent            = t('backBtn');
            document.getElementById('tool-rect').title                 = t('toolRect');
            document.getElementById('tool-line').title                 = t('toolLine');
            document.getElementById('tool-undo').title                 = t('undo');
            document.getElementById('tool-redo').title                 = t('redo');
            document.getElementById('title-scale').textContent         = t('titleScale');
            document.getElementById('title-project-name').textContent  = t('titleProjectName');
            document.getElementById('project-name').placeholder        = t('projectNamePlaceholder');
            document.getElementById('footer-made-by').textContent      = t('madeBy');
            document.getElementById('label-pxw').textContent           = t('labelPxW');

            updateModelSizeLbl();
            const flagMap = {no:'no',en:'gb',de:'de',fr:'fr',es:'es',pt:'pt',zh:'cn',ja:'jp',sv:'se',da:'dk',fi:'fi'};
            document.getElementById('lang-flag').src =
                `https://flagcdn.com/20x15/${flagMap[currentLang]||'no'}.png`;
            document.querySelectorAll('.lang-opt').forEach(opt =>
                opt.classList.toggle('active', opt.dataset.lang === currentLang));
            document.documentElement.lang = currentLang;
            buildSwatches();
            updateStats();
            updatePreviewStats();
        }

        document.getElementById('lang-btn').addEventListener('click', e => {
            e.stopPropagation();
            document.getElementById('lang-menu').classList.toggle('open');
        });
        document.querySelectorAll('.lang-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                currentLang = opt.dataset.lang;
                localStorage.setItem('pixelprint-lang', currentLang);
                document.getElementById('lang-menu').classList.remove('open');
                applyLang();
            });
        });
        document.addEventListener('click', () =>
            document.getElementById('lang-menu').classList.remove('open'));

        // ── PNG EXPORT ───────────────────────────────────────────────────
        document.getElementById('export-png-btn').addEventListener('click', () => {
            const scale = 16;
            const canvas = document.createElement('canvas');
            canvas.width = GRID * scale; canvas.height = GRID * scale;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#12121a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++)
                    if (board[y][x]) {
                        ctx.fillStyle = board[y][x];
                        ctx.fillRect(x * scale, y * scale, scale, scale);
                    }
            canvas.toBlob(blob => {
                const name = (document.getElementById('project-name').value.trim() || 'pixelart')
                    .replace(/[^a-zA-Z0-9_\-æøåÆØÅ ]/g, '').trim().replace(/ +/g, '_') || 'pixelart';
                saveAs(blob, name + '.png');
            });
        });

        // ── PNG IMPORT ───────────────────────────────────────────────────
        let pngClusters = []; // [{color:[r,g,b], pixels:[{x,y}], count, targetHex, erase}]

        function rgbToHex(r, g, b) {
            return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        }

        function kMeans(rawPixels, k) {
            const pts = rawPixels.map(p => [p.r, p.g, p.b]);
            // k-means++ init
            const freq = {};
            pts.forEach(p => { const k = p.join(); freq[k] = (freq[k]||0) + 1; });
            const byFreq = Object.entries(freq).sort((a,b) => b[1]-a[1]);
            const centroids = [byFreq[0][0].split(',').map(Number)];
            for (let c = 1; c < k; c++) {
                const dists = pts.map(p => Math.min(...centroids.map(
                    ctr => (p[0]-ctr[0])**2 + (p[1]-ctr[1])**2 + (p[2]-ctr[2])**2)));
                const sum = dists.reduce((s, d) => s + d, 0);
                let r = Math.random() * sum;
                let chosen = 0;
                for (let i = 0; i < dists.length; i++) { r -= dists[i]; if (r <= 0) { chosen = i; break; } }
                centroids.push([...pts[chosen]]);
            }
            // Iterate
            for (let iter = 0; iter < 30; iter++) {
                const clusters = Array.from({length: k}, () => []);
                pts.forEach(p => {
                    let bi = 0, bd = Infinity;
                    centroids.forEach((c, i) => { const d = (p[0]-c[0])**2+(p[1]-c[1])**2+(p[2]-c[2])**2; if (d < bd) { bd = d; bi = i; } });
                    clusters[bi].push(p);
                });
                let changed = false;
                centroids.forEach((c, i) => {
                    if (!clusters[i].length) return;
                    const nr = Math.round(clusters[i].reduce((s,p)=>s+p[0],0)/clusters[i].length);
                    const ng = Math.round(clusters[i].reduce((s,p)=>s+p[1],0)/clusters[i].length);
                    const nb = Math.round(clusters[i].reduce((s,p)=>s+p[2],0)/clusters[i].length);
                    if (c[0]!==nr||c[1]!==ng||c[2]!==nb) { changed = true; centroids[i] = [nr,ng,nb]; }
                });
                if (!changed) break;
            }
            return centroids;
        }

        function processImageSource(source) {
            const canvas = document.createElement('canvas');
            canvas.width = GRID; canvas.height = GRID;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(source, 0, 0, GRID, GRID);
            const data = ctx.getImageData(0, 0, GRID, GRID).data;
            const opaquePixels = [];
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++) {
                    const i = (y * GRID + x) * 4;
                    if (data[i+3] >= 128)
                        opaquePixels.push({x, y, r: data[i], g: data[i+1], b: data[i+2]});
                }
            if (!opaquePixels.length) { alert('No opaque pixels found.'); return; }
            const k = Math.min(4, new Set(opaquePixels.map(p => `${p.r},${p.g},${p.b}`)).size);
            const centroids = kMeans(opaquePixels, k);
            pngClusters = centroids.map(c => ({color: c, pixels: [], count: 0, targetHex: rgbToHex(...c), erase: false}));
            opaquePixels.forEach(px => {
                let bi = 0, bd = Infinity;
                centroids.forEach((c, i) => { const d = (px.r-c[0])**2+(px.g-c[1])**2+(px.b-c[2])**2; if (d < bd) { bd = d; bi = i; } });
                pngClusters[bi].pixels.push({x: px.x, y: px.y});
                pngClusters[bi].count++;
            });
            pngClusters.sort((a, b) => b.count - a.count);
            showPngModal();
        }

        function importPng(file) {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => { URL.revokeObjectURL(url); processImageSource(img); };
            img.src = url;
        }

        function importPixil(data) {
            const layers = data.frames[0].layers;
            const offscreen = document.createElement('canvas');
            offscreen.width = GRID; offscreen.height = GRID;
            const octx = offscreen.getContext('2d');
            let loaded = 0;
            const imgs = layers.map(() => new Image());
            imgs.forEach((img, i) => {
                img.onload = () => {
                    if (++loaded < layers.length) return;
                    imgs.forEach((im, j) => {
                        octx.globalAlpha = layers[j].opacity ?? 1;
                        octx.globalCompositeOperation = layers[j].options?.blend ?? 'source-over';
                        octx.drawImage(im, 0, 0, GRID, GRID);
                    });
                    octx.globalAlpha = 1;
                    octx.globalCompositeOperation = 'source-over';
                    processImageSource(offscreen);
                };
                const src = layers[i].src;
                img.src = 'data:image/png;base64,' + src.substring(src.indexOf(',') + 1);
            });
        }

        function showPngModal() {
            const rowsEl = document.getElementById('color-map-rows');
            rowsEl.innerHTML = '';
            pngClusters.forEach((cluster, i) => {
                const row = document.createElement('div');
                row.className = 'color-map-row';
                row.innerHTML = `
                    <div class="color-map-swatch" style="background:${cluster.targetHex}"></div>
                    <span class="color-map-arrow">→</span>
                    <input type="color" class="color-map-target" value="${cluster.targetHex}" data-idx="${i}">
                    <button class="color-map-erase-btn" data-idx="${i}" title="Erase"><i data-lucide="eraser"></i></button>
                    <span class="color-map-count">${cluster.count}px</span>
                `;
                const colorInput = row.querySelector('.color-map-target');
                const eraseBtn   = row.querySelector('.color-map-erase-btn');
                colorInput.addEventListener('input', e => {
                    pngClusters[i].targetHex = e.target.value;
                    pngClusters[i].erase = false;
                    eraseBtn.classList.remove('active');
                    colorInput.style.opacity = '1';
                });
                eraseBtn.addEventListener('click', () => {
                    pngClusters[i].erase = !pngClusters[i].erase;
                    eraseBtn.classList.toggle('active');
                    colorInput.style.opacity = pngClusters[i].erase ? '0.3' : '1';
                });
                rowsEl.appendChild(row);
            });
            lucide.createIcons({nodes: [rowsEl], attrs: {'stroke-width': 1.75}});
            document.getElementById('png-modal').classList.add('open');
        }

        document.getElementById('png-apply').addEventListener('click', () => {
            // Snapshot for undo
            const changes = [];
            for (let y = 0; y < GRID; y++)
                for (let x = 0; x < GRID; x++)
                    changes.push({x, y, from: board[y][x], to: null});

            // Apply clusters to board
            pngClusters.forEach(cluster => {
                if (cluster.erase) return;
                cluster.pixels.forEach(({x, y}) => {
                    const entry = changes.find(c => c.x === x && c.y === y);
                    if (entry) entry.to = cluster.targetHex;
                });
            });

            // Commit to board and repaint
            changes.forEach(({x, y, to}) => {
                board[y][x] = to;
                getCellEl(x, y).style.background = to ?? '#12121a';
                if (threejsReady) {
                    cubes3d[y][x].visible = to !== null;
                    if (to) cubes3d[y][x].material.color.set(to);
                }
            });

            // Update palette with non-erased colors
            const newColors = pngClusters.filter(c => !c.erase).map(c => c.targetHex);
            for (let i = 0; i < palette.length; i++)
                if (newColors[i]) palette[i] = newColors[i];

            const realChanges = changes.filter(c => c.from !== c.to);
            if (realChanges.length) { undoStack.push(realChanges); redoStack = []; }

            buildSwatches();
            updateStats();
            autosave();
            document.getElementById('png-modal').classList.remove('open');
        });

        document.getElementById('png-cancel').addEventListener('click', () => {
            document.getElementById('png-modal').classList.remove('open');
        });

        // ── BOOT ─────────────────────────────────────────────────────────
        try {
            const saved = JSON.parse(localStorage.getItem('pixelprint-state'));
            if (saved?.board && saved?.palette) {
                board   = saved.board;
                palette = saved.palette;
                if (saved.pixelSizeX) {
                    pixelSizeX = saved.pixelSizeX;
                    document.getElementById('px-size-x').value = pixelSizeX;
                    document.getElementById('px-size-x-val').textContent = pixelSizeX;
                }
                if (saved.thickness) {
                    document.getElementById('thickness').value = saved.thickness;
                    document.getElementById('thickness-val').textContent = saved.thickness.toFixed(1);
                }
                if (saved.projectName) {
                    document.getElementById('project-name').value = saved.projectName;
                }
            }
        } catch(e) {}
        lucide.createIcons({attrs:{"stroke-width":1.75}});
        buildBoard();
        updateCellSize();
        // Repaint restored board
        for (let y = 0; y < GRID; y++)
            for (let x = 0; x < GRID; x++)
                if (board[y][x]) getCellEl(x, y).style.background = board[y][x];
        buildSwatches();
        updateStats();
        applyLang();