/**
 * panel.js - Parameter Adjustment Panel (migrated from sea_surface/ui.js)
 *
 * Generic widget library: section grouping, collapsible descriptions,
 * slider+number inputs, color/boolean/select/button/info controls.
 * Controls write directly to the bound target object, so binding the
 * reactive config Proxy gives live updates for free.
 */

// Panel container
let panelContainer = null;
let onChangeCallback = null;

// Registry of live controls: path -> { target, key, setDisplay }
const registry = new Map();

// Create panel styles
function createStyles() {
    if (document.getElementById('param-panel-styles')) return;

    const style = document.createElement('style');
    style.id = 'param-panel-styles';
    style.textContent = `
        .param-panel {
            position: fixed;
            top: 12px;
            right: 12px;
            width: 260px;
            max-height: calc(100vh - 24px);
            overflow-y: auto;
            background: rgba(20, 25, 35, 0.95);
            border-radius: 8px;
            padding: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #e0e6ed;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            z-index: 1000;
        }

        .param-panel::-webkit-scrollbar {
            width: 6px;
        }

        .param-panel::-webkit-scrollbar-track {
            background: transparent;
        }

        .param-panel::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 3px;
        }

        .panel-header {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 10px;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.15);
            color: #fff;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            user-select: none;
        }

        .panel-header-text {
            flex: 1;
        }

        .panel-toggle-arrow {
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #8b9dc3;
            font-size: 12px;
            transition: transform 0.3s ease;
            cursor: pointer;
        }

        .panel-toggle-arrow:hover {
            color: #fff;
        }

        .panel-toggle-arrow.collapsed {
            transform: rotate(-90deg);
        }

        .panel-content {
            overflow: hidden;
            transition: max-height 0.3s ease, opacity 0.3s ease;
            max-height: 2000px;
            opacity: 1;
        }

        .panel-content.collapsed {
            max-height: 0;
            opacity: 0;
        }

        .section {
            margin-bottom: 10px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 6px;
            padding: 8px;
            border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .section:last-child {
            margin-bottom: 0;
        }

        .section-title {
            font-size: 11px;
            font-weight: 600;
            color: #8b9dc3;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
            padding-left: 2px;
        }

        .param-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 2px;
            min-height: 24px;
        }

        .param-label-wrapper {
            display: flex;
            align-items: center;
            gap: 8px;
            flex: 1;
        }

        .param-label {
            font-size: 12px;
            color: #c5d0e0;
            font-weight: 400;
        }

        .info-icon {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: rgba(100, 150, 255, 0.2);
            color: #64a0ff;
            font-size: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s ease;
            user-select: none;
            font-family: Georgia, serif;
            font-style: italic;
        }

        .info-icon:hover {
            background: rgba(100, 150, 255, 0.35);
            transform: scale(1.1);
        }

        .info-icon.active {
            background: rgba(100, 150, 255, 0.5);
            color: #fff;
        }

        .param-input-wrapper {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .param-description {
            font-size: 10px;
            color: #8b9dc3;
            line-height: 1.4;
            margin: 2px 0 4px 0;
            padding: 6px 8px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 4px;
            border-left: 2px solid rgba(100, 150, 255, 0.4);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            max-height: 0;
            overflow: hidden;
            opacity: 0;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            margin-top: 0;
            margin-bottom: 0;
            padding-top: 0;
            padding-bottom: 0;
        }

        .param-description.visible {
            max-height: 150px;
            opacity: 1;
            margin: 2px 0 4px 0;
            padding: 6px 8px;
        }

        .param-item {
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }

        .param-item:last-child {
            border-bottom: none;
        }

        /* Input control styles */
        .param-input {
            width: 56px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            padding: 3px 6px;
            color: #fff;
            font-size: 11px;
            text-align: right;
            outline: none;
            transition: border-color 0.2s;
        }

        .param-input:focus {
            border-color: rgba(100, 150, 255, 0.5);
        }

        .param-slider {
            width: 60px;
            height: 3px;
            -webkit-appearance: none;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
            outline: none;
        }

        .param-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 10px;
            height: 10px;
            background: #64a0ff;
            border-radius: 50%;
            cursor: pointer;
        }

        .param-color {
            width: 24px;
            height: 18px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            background: transparent;
        }

        .param-toggle {
            width: 32px;
            height: 16px;
            background: rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            position: relative;
            cursor: pointer;
            transition: background 0.2s;
        }

        .param-toggle.active {
            background: #64a0ff;
        }

        .param-toggle::after {
            content: '';
            position: absolute;
            width: 12px;
            height: 12px;
            background: #fff;
            border-radius: 50%;
            top: 2px;
            left: 2px;
            transition: transform 0.2s;
        }

        .param-toggle.active::after {
            transform: translateX(16px);
        }

        .param-button {
            padding: 5px 12px;
            background: linear-gradient(135deg, #64a0ff 0%, #4a80dd 100%);
            border: none;
            border-radius: 4px;
            color: #fff;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            box-shadow: 0 2px 6px rgba(100, 160, 255, 0.3);
        }

        .param-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 3px 8px rgba(100, 160, 255, 0.4);
        }

        .param-button:active {
            transform: translateY(0);
        }

        .param-info {
            font-size: 11px;
            color: #8b9dc3;
            font-family: 'SF Mono', Menlo, monospace;
        }
    `;
    document.head.appendChild(style);
}

// Hex color conversion
function hexToNumber(hex) {
    if (typeof hex === 'number') return hex;
    if (hex.startsWith('0x')) return parseInt(hex.slice(2), 16);
    if (hex.startsWith('#')) return parseInt(hex.slice(1), 16);
    return hex;
}

function numberToHex(num) {
    return '#' + num.toString(16).padStart(6, '0');
}

// Decimal places to show for a given step
function stepDecimals(step) {
    if (!step || step >= 1) return 0;
    return Math.min(3, Math.ceil(-Math.log10(step)));
}

// Register a live control so it can be refreshed/updated by path
function register(path, target, key, setDisplay) {
    registry.set(path, { target, key, setDisplay });
}

// Create parameter item
function createParamItem(def, target, key, path) {
    const item = document.createElement('div');
    item.className = 'param-item';

    const row = document.createElement('div');
    row.className = 'param-row';

    // Label and info icon
    const labelWrapper = document.createElement('div');
    labelWrapper.className = 'param-label-wrapper';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = def.label || key;
    labelWrapper.appendChild(label);

    // Expand/collapse description
    let descriptionEl = null;
    if (def.description) {
        const infoIcon = document.createElement('span');
        infoIcon.className = 'info-icon';
        infoIcon.innerHTML = 'i';

        descriptionEl = document.createElement('div');
        descriptionEl.className = 'param-description';
        descriptionEl.textContent = def.description;

        infoIcon.addEventListener('click', () => {
            infoIcon.classList.toggle('active');
            descriptionEl.classList.toggle('visible');
        });

        labelWrapper.appendChild(infoIcon);
    }

    row.appendChild(labelWrapper);

    // Input control
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'param-input-wrapper';

    const type = def.type || inferType(target[key]);

    switch (type) {
        case 'number': {
            const value = target[key];
            if (def.min !== undefined && def.max !== undefined) {
                // Slider + number input
                const decimals = stepDecimals(def.step);

                const slider = document.createElement('input');
                slider.type = 'range';
                slider.className = 'param-slider';
                slider.min = def.min;
                slider.max = def.max;
                slider.step = def.step || 0.01;
                slider.value = value;

                const numInput = document.createElement('input');
                numInput.type = 'number';
                numInput.className = 'param-input';
                numInput.value = value.toFixed(decimals);

                slider.addEventListener('input', () => {
                    const val = parseFloat(slider.value);
                    numInput.value = val.toFixed(decimals);
                    target[key] = val;
                    notifyChange(path, val);
                });

                numInput.addEventListener('change', () => {
                    let val = parseFloat(numInput.value);
                    val = Math.max(def.min, Math.min(def.max, val));
                    slider.value = val;
                    numInput.value = val.toFixed(decimals);
                    target[key] = val;
                    notifyChange(path, val);
                });

                inputWrapper.appendChild(slider);
                inputWrapper.appendChild(numInput);

                register(path, target, key, (v) => {
                    slider.value = v;
                    numInput.value = Number(v).toFixed(decimals);
                });
            } else {
                // Number input only
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'param-input';
                input.value = value;
                input.step = def.step || 'any';

                input.addEventListener('change', () => {
                    const val = parseFloat(input.value);
                    target[key] = val;
                    notifyChange(path, val);
                });

                inputWrapper.appendChild(input);
                register(path, target, key, (v) => { input.value = v; });
            }
            break;
        }

        case 'color': {
            const value = target[key];
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'param-color';
            colorInput.value = numberToHex(hexToNumber(value));

            colorInput.addEventListener('change', () => {
                const val = hexToNumber(colorInput.value);
                target[key] = val;
                notifyChange(path, val);
            });

            inputWrapper.appendChild(colorInput);
            register(path, target, key, (v) => {
                colorInput.value = numberToHex(hexToNumber(v));
            });
            break;
        }

        case 'boolean': {
            const value = target[key];
            const toggle = document.createElement('div');
            toggle.className = 'param-toggle' + (value ? ' active' : '');

            toggle.addEventListener('click', () => {
                toggle.classList.toggle('active');
                const val = toggle.classList.contains('active');
                target[key] = val;
                notifyChange(path, val);
            });

            inputWrapper.appendChild(toggle);
            register(path, target, key, (v) => {
                toggle.classList.toggle('active', !!v);
            });
            break;
        }

        case 'select': {
            const value = target[key];
            const select = document.createElement('select');
            select.className = 'param-input';
            select.style.width = '90px';

            const isNumeric = def.options.every(opt => typeof opt.value === 'number');

            def.options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.label;
                if (opt.value === value) option.selected = true;
                select.appendChild(option);
            });

            select.addEventListener('change', () => {
                const val = isNumeric ? parseFloat(select.value) : select.value;
                target[key] = val;
                notifyChange(path, val);
            });

            inputWrapper.appendChild(select);
            register(path, target, key, (v) => { select.value = v; });
            break;
        }

        case 'button': {
            const button = document.createElement('button');
            button.className = 'param-button';
            button.textContent = def.buttonText || 'Apply';
            button.onclick = () => {
                if (def.onClick) {
                    def.onClick();
                }
                notifyChange(path, 'clicked');
            };
            inputWrapper.appendChild(button);
            break;
        }

        case 'info': {
            const span = document.createElement('span');
            span.className = 'param-info';
            span.textContent = target[key];
            inputWrapper.appendChild(span);
            register(path, target, key, (v) => { span.textContent = v; });
            break;
        }
    }

    row.appendChild(inputWrapper);
    item.appendChild(row);

    if (descriptionEl) {
        item.appendChild(descriptionEl);
    }

    return item;
}

// Infer type
function inferType(value) {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') return 'string';
    return 'text';
}

// Notify change
function notifyChange(path, value) {
    if (onChangeCallback) {
        onChangeCallback(path, value);
    }
}

// Create section
function createSection(title, configs, target, basePath = '') {
    const section = document.createElement('div');
    section.className = 'section';

    if (title) {
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'section-title';
        sectionTitle.textContent = title;
        section.appendChild(sectionTitle);
    }

    configs.forEach(def => {
        const path = basePath ? `${basePath}.${def.key}` : def.key;
        const item = createParamItem(def, target, def.key, path);
        section.appendChild(item);
    });

    return section;
}

/**
 * Create parameter panel
 * @param {Object} options - Configuration options
 * @param {string} options.title - Panel title
 * @param {Array} options.sections - Section configuration array
 * @param {Array} [options.buttons] - Bottom button definitions
 * @param {boolean} [options.startCollapsed] - Collapse content on creation
 * @param {Function} options.onChange - Parameter change callback
 * @returns {HTMLElement} Panel container
 */
export function createPanel(options) {
    createStyles();
    registry.clear();

    onChangeCallback = options.onChange;

    panelContainer = document.createElement('div');
    panelContainer.className = 'param-panel';

    // Content container
    const contentContainer = document.createElement('div');
    contentContainer.className = 'panel-content' + (options.startCollapsed ? ' collapsed' : '');

    if (options.title) {
        const header = document.createElement('div');
        header.className = 'panel-header';

        const headerText = document.createElement('span');
        headerText.className = 'panel-header-text';
        headerText.textContent = options.title;
        header.appendChild(headerText);

        // Collapse arrow
        const arrow = document.createElement('span');
        arrow.className = 'panel-toggle-arrow' + (options.startCollapsed ? ' collapsed' : '');
        arrow.innerHTML = '▼';
        header.appendChild(arrow);

        // Toggle collapse on header click
        header.addEventListener('click', () => {
            contentContainer.classList.toggle('collapsed');
            arrow.classList.toggle('collapsed');
        });

        panelContainer.appendChild(header);
    }

    options.sections.forEach(section => {
        const sectionEl = createSection(
            section.title,
            section.params,
            section.target,
            section.path || ''
        );
        contentContainer.appendChild(sectionEl);
    });

    // Add bottom button area
    if (options.buttons && options.buttons.length > 0) {
        const buttonSection = document.createElement('div');
        buttonSection.className = 'section button-section';
        buttonSection.style.marginTop = '8px';
        buttonSection.style.paddingTop = '8px';
        buttonSection.style.borderTop = '1px solid rgba(255,255,255,0.1)';
        buttonSection.style.display = 'flex';
        buttonSection.style.gap = '6px';
        buttonSection.style.justifyContent = 'center';

        options.buttons.forEach(btnConfig => {
            const btn = document.createElement('button');
            btn.className = 'param-button';
            btn.textContent = btnConfig.label;
            btn.style.flex = '1';
            if (btnConfig.primary) {
                btn.style.background = 'linear-gradient(135deg, #64a0ff 0%, #4a80dd 100%)';
            } else {
                btn.style.background = 'rgba(255,255,255,0.1)';
            }
            btn.onclick = () => {
                if (btnConfig.onClick) {
                    btnConfig.onClick();
                }
            };
            buttonSection.appendChild(btn);
        });

        contentContainer.appendChild(buttonSection);
    }

    panelContainer.appendChild(contentContainer);
    document.body.appendChild(panelContainer);
    return panelContainer;
}

/**
 * Update a control's displayed value by path (does not write to target)
 * @param {string} path - Parameter path
 * @param {*} value - New value
 */
export function updateParamValue(path, value) {
    const entry = registry.get(path);
    if (entry) {
        entry.setDisplay(value);
    }
}

/**
 * Re-sync every control from its bound target (e.g. after presets/reset)
 */
export function refreshPanel() {
    registry.forEach(entry => {
        entry.setDisplay(entry.target[entry.key]);
    });
}

/**
 * Destroy panel
 */
export function destroyPanel() {
    if (panelContainer) {
        panelContainer.remove();
        panelContainer = null;
    }
    registry.clear();
    onChangeCallback = null;
}

/**
 * Show/hide panel
 * @param {boolean} show
 */
export function togglePanel(show) {
    if (panelContainer) {
        panelContainer.style.display = show ? 'block' : 'none';
    }
}
