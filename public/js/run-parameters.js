/* Run parameters: task editor section, manual run form and history formatting (SDD v0.8.0).
 * Validation and argv composition reuse the server rules served as CrontabRunParameterRules,
 * so the preview shows exactly what the server composes. The server always validates again. */
(function(root) {
  var ROLE_LEVEL = { viewer: 0, executor: 1, operator: 2, admin: 3 };
  var TYPES = ['flag', 'date', 'month', 'select', 'integer', 'text'];
  var ROLES = ['executor', 'operator', 'admin'];
  var context = { tr: function(key) { return key; }, role: null };
  var editorState = [];

  function rules() {
    return root.CrontabRunParameterRules;
  }

  function tr(key, values) {
    return context.tr(key, values);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function init(options) {
    context.tr = options.tr || context.tr;
    context.role = options.role || null;
  }

  function allowedForRole(definition, role) {
    var current = ROLE_LEVEL[role === undefined ? context.role : role];
    return current !== undefined && current >= ROLE_LEVEL[definition.min_role || 'executor'];
  }

  function quoteToken(token) {
    return /^[A-Za-z0-9._:/@+=,-]+$/.test(token) ? token : JSON.stringify(token);
  }

  // Readable form of the active values of a past run, e.g. "--date 2026-11-15 --delete".
  function formatValues(definitions, values) {
    if (!values || typeof values !== 'object' || !Object.keys(values).length) return '';
    try {
      var normalized = rules().validateRunParameterDefinitions(definitions || []);
      // History stores only the active values: an absent parameter was inactive in that run,
      // so it must not fall back to the current default.
      var complete = {};
      normalized.forEach(function(definition) {
        complete[definition.name] = Object.prototype.hasOwnProperty.call(values, definition.name)
          ? values[definition.name] : (definition.type === 'flag' ? false : null);
      });
      Object.keys(values).forEach(function(name) {
        if (!Object.prototype.hasOwnProperty.call(complete, name)) complete[name] = values[name];
      });
      return rules().resolveRunParameters(normalized, complete, []).tokens.map(quoteToken).join(' ');
    } catch (_error) {
      return Object.keys(values).map(function(name) { return name + '=' + String(values[name]); }).join(' ');
    }
  }

  /* ---------------- Task editor ---------------- */

  function emptyDefinition() {
    return { name: '', flag: '', type: 'flag', label: '' };
  }

  function optionsToText(options) {
    return (options || []).map(function(option) {
      return option.label && option.label !== option.value ? option.value + '|' + option.label : option.value;
    }).join('\n');
  }

  function textToOptions(text) {
    return String(text || '').split('\n').map(function(line) { return line.trim(); }).filter(Boolean).map(function(line) {
      var separator = line.indexOf('|');
      if (separator === -1) return { value: line, label: line };
      return { value: line.slice(0, separator).trim(), label: line.slice(separator + 1).trim() };
    });
  }

  function fillEditor(definitions) {
    editorState = (definitions || []).map(function(definition) {
      var copy = JSON.parse(JSON.stringify(definition));
      if (copy.options) copy.optionsText = optionsToText(copy.options);
      return copy;
    });
    renderEditor();
  }

  function integerOrUndefined(value) {
    if (value === '' || value === null || value === undefined) return undefined;
    var number = Number(value);
    return Number.isFinite(number) ? number : value;
  }

  // Builds the definitions sent to the server: only the fields relevant to each type, without
  // empty optional values. The server normalises and validates them.
  function readEditor() {
    return editorState.map(function(state) {
      var definition = { name: state.name, flag: state.flag, type: state.type, label: state.label };
      if (state.help) definition.help = state.help;
      if (state.confirm) definition.confirm = true;
      if (state.min_role && state.min_role !== 'executor') definition.min_role = state.min_role;
      if (state.type === 'flag') {
        if (state.default === true) definition.default = true;
        return definition;
      }
      if (state.required) definition.required = true;
      if (state.style === 'equals') definition.style = 'equals';
      if (isCalendarType(state.type)) {
        if (state.min) definition.min = state.min;
        if (state.max) definition.max = state.max;
      } else if (state.type === 'integer') {
        definition.min = integerOrUndefined(state.min);
        definition.max = integerOrUndefined(state.max);
      } else if (state.type === 'select') {
        definition.options = textToOptions(state.optionsText);
      } else if (state.type === 'text') {
        definition.pattern = state.pattern || '';
        var maxLength = integerOrUndefined(state.max_length);
        if (maxLength !== undefined) definition.max_length = maxLength;
      }
      if (state.default !== undefined && state.default !== null && state.default !== '') {
        definition.default = state.type === 'integer' ? integerOrUndefined(state.default) : state.default;
      }
      return definition;
    });
  }

  function validName(name) {
    return rules().NAME_PATTERN.test(String(name || ''));
  }

  // Suggested technical name for a new parameter: "--Date-From" becomes "date_from".
  function nameFromFlag(flag) {
    return String(flag || '').toLowerCase().replace(/^-+/, '').replace(/[^a-z0-9_]/g, '_')
      .replace(/^[^a-z]+/, '').slice(0, 32);
  }

  function markNameField(input, help, invalid) {
    input.classList.toggle('is-invalid', invalid);
    help.classList.toggle('text-danger', invalid);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  // Checks the technical names before saving, because the server error does not point to the
  // field. Marks and focuses the first invalid one; returns false when the save must not proceed.
  function checkEditor() {
    var firstInvalid = null;
    editorState.forEach(function(state, index) {
      var input = document.getElementById('run-parameter-' + index + '-name');
      var help = document.getElementById('run-parameter-' + index + '-name-help');
      var invalid = !validName(state.name);
      if (input && help) markNameField(input, help, invalid);
      if (invalid && !firstInvalid) firstInvalid = input;
    });
    if (!firstInvalid && editorState.some(function(state) { return !validName(state.name); })) return false;
    if (firstInvalid) {
      if (firstInvalid.scrollIntoView) firstInvalid.scrollIntoView({ block: 'center' });
      firstInvalid.focus();
      return false;
    }
    return true;
  }

  function setEditorTarget(targetId) {
    var unsupported = targetId === 'ubuntu-local';
    var notice = document.getElementById('run-parameters-unsupported');
    var add = document.getElementById('job-add-run-parameter');
    if (notice) notice.classList.toggle('d-none', !unsupported);
    if (add) add.disabled = unsupported;
  }

  function editorField(id, labelText, control, columnClass) {
    var column = el('div', columnClass || 'col-md-6');
    var label = el('label', 'form-label', labelText);
    label.setAttribute('for', id);
    (control.fieldInput || control).id = id;
    column.append(label, control);
    return column;
  }

  function textInput(state, key, options) {
    var input = el('input', 'form-control' + (options && options.monospace ? ' font-monospace' : ''));
    input.type = (options && options.type) || 'text';
    input.value = state[key] === undefined || state[key] === null ? '' : String(state[key]);
    if (options && options.placeholder) input.placeholder = options.placeholder;
    if (options && options.maxLength) input.maxLength = options.maxLength;
    input.addEventListener('input', function() { state[key] = input.value; });
    return input;
  }

  // Dates and months are typed as ISO text (YYYY-MM-DD, YYYY-MM), the exact value the script
  // receives. The native date control is avoided because it shows the browser's regional format.
  var CALENDAR_FORMATS = {
    date: { placeholder: 'YYYY-MM-DD', length: 10 },
    month: { placeholder: 'YYYY-MM', length: 7 },
  };

  function isCalendarType(type) {
    return Object.prototype.hasOwnProperty.call(CALENDAR_FORMATS, type);
  }

  function maskIso(value, mode) {
    var digits = String(value || '').replace(/\D/g, '').slice(0, mode === 'month' ? 6 : 8);
    if (digits.length > 6) return digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6);
    if (digits.length > 4) return digits.slice(0, 4) + '-' + digits.slice(4);
    return digits;
  }

  // Configures a text input for an ISO date or month. Must run before other input listeners are
  // added, so they read the masked value.
  function isoCalendarInput(input, mode) {
    var format = CALENDAR_FORMATS[mode];
    input.type = 'text';
    input.placeholder = format.placeholder;
    input.maxLength = format.length;
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.classList.add('font-monospace');
    input.addEventListener('input', function() {
      var masked = maskIso(input.value, mode);
      if (masked !== input.value) input.value = masked;
    });
    return input;
  }

  function calendarInput(state, key, mode) {
    var input = isoCalendarInput(el('input', 'form-control'), mode);
    input.value = state[key] === undefined || state[key] === null ? '' : String(state[key]);
    input.addEventListener('input', function() { state[key] = input.value; });
    return withDatePicker(input, {}, mode);
  }

  /* ---------------- Date picker ----------------
   * Always in English, independent of the browser language (the native calendar follows the
   * browser locale). It only fills the ISO text field; validation stays with the shared rules.
   * Mode "date" shows the days of a month; mode "month" shows the months of a year. */

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var activePicker = null;

  function pad(number) {
    return (number < 10 ? '0' : '') + number;
  }

  function isoFromParts(year, month, day) {
    return year + '-' + pad(month + 1) + (day === undefined ? '' : '-' + pad(day));
  }

  // Parses a value of the picker's mode into a UTC date (first day for months), or null.
  function parseValue(mode, value) {
    var match = mode === 'month' ? /^(\d{4})-(\d{2})$/.exec(value || '') : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match) return null;
    var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, mode === 'month' ? 1 : Number(match[3])));
    return date.getUTCMonth() === Number(match[2]) - 1 ? date : null;
  }

  function formatValue(mode, date) {
    return isoFromParts(date.getUTCFullYear(), date.getUTCMonth(), mode === 'month' ? undefined : date.getUTCDate());
  }

  function stepValue(mode, value, steps) {
    var date = parseValue(mode, value);
    if (mode === 'month') date.setUTCMonth(date.getUTCMonth() + steps);
    else date.setUTCDate(date.getUTCDate() + steps);
    return formatValue(mode, date);
  }

  function currentValue(mode) {
    var now = new Date();
    return isoFromParts(now.getFullYear(), now.getMonth(), mode === 'month' ? undefined : now.getDate());
  }

  function outOfRange(picker, iso) {
    return Boolean((picker.limits.min && iso < picker.limits.min) || (picker.limits.max && iso > picker.limits.max));
  }

  function fireInput(input) {
    if (typeof Event === 'function' && input.dispatchEvent) input.dispatchEvent(new Event('input', { bubbles: true }));
    else if (input.dispatch) input.dispatch('input');
  }

  function pickerButton(className, text, label, onClick) {
    var button = el('button', className, text);
    button.type = 'button';
    if (label) button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  function closeDatePicker(restoreFocus) {
    if (!activePicker) return;
    var picker = activePicker;
    activePicker = null;
    picker.wrapper.replaceChildren(picker.group);
    picker.toggle.setAttribute('aria-expanded', 'false');
    if (document.removeEventListener) document.removeEventListener('mousedown', picker.outside, true);
    if (restoreFocus) picker.toggle.focus();
  }

  function selectDate(picker, iso) {
    picker.input.value = iso;
    fireInput(picker.input);
    closeDatePicker(true);
  }

  function moveFocus(picker, iso) {
    picker.focusIso = iso;
    var date = parseValue(picker.mode, iso);
    picker.year = date.getUTCFullYear();
    picker.month = date.getUTCMonth();
    renderDatePicker(picker);
    if (picker.buttons[iso]) picker.buttons[iso].focus();
  }

  function onCellKey(picker, iso, event) {
    var row = picker.mode === 'month' ? 3 : 7;
    var steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -row, ArrowDown: row };
    if (Object.prototype.hasOwnProperty.call(steps, event.key)) {
      event.preventDefault();
      moveFocus(picker, stepValue(picker.mode, iso, steps[event.key]));
    }
  }

  // Moves the view by one page: a month in date mode, a year in month mode.
  function changePage(picker, delta) {
    if (picker.mode === 'month') {
      picker.year += delta;
    } else {
      var month = picker.month + delta;
      picker.year += Math.floor(month / 12);
      picker.month = ((month % 12) + 12) % 12;
    }
    renderDatePicker(picker);
  }

  function pickerCell(picker, iso, text, label, focusable) {
    var button = pickerButton('run-date-picker-day', text, label, function() { selectDate(picker, iso); });
    button.setAttribute('data-date', iso);
    button.disabled = outOfRange(picker, iso);
    button.setAttribute('aria-pressed', iso === picker.input.value ? 'true' : 'false');
    if (iso === currentValue(picker.mode)) button.setAttribute('aria-current', 'date');
    button.tabIndex = focusable ? 0 : -1;
    button.addEventListener('keydown', function(event) { onCellKey(picker, iso, event); });
    picker.buttons[iso] = button;
    return button;
  }

  function renderDatePicker(picker) {
    var monthMode = picker.mode === 'month';
    var title = el('span', 'run-date-picker-title', monthMode ? String(picker.year) : MONTHS[picker.month] + ' ' + picker.year);
    title.setAttribute('aria-live', 'polite');
    var header = el('div', 'run-date-picker-header');
    header.append(
      pickerButton('btn btn-sm btn-link run-date-picker-nav', '\u2039', monthMode ? 'Previous year' : 'Previous month', function() { changePage(picker, -1); }),
      title,
      pickerButton('btn btn-sm btn-link run-date-picker-nav', '\u203a', monthMode ? 'Next year' : 'Next month', function() { changePage(picker, 1); })
    );

    var grid = el('div', 'run-date-picker-grid' + (monthMode ? ' run-date-picker-months' : ''));
    picker.buttons = {};
    var pagePrefix = monthMode ? String(picker.year) : isoFromParts(picker.year, picker.month);
    var focusOnPage = Boolean(picker.focusIso) && picker.focusIso.slice(0, pagePrefix.length) === pagePrefix;
    if (monthMode) {
      MONTHS.forEach(function(name, month) {
        var iso = isoFromParts(picker.year, month);
        grid.appendChild(pickerCell(picker, iso, name.slice(0, 3), name + ' ' + picker.year,
          focusOnPage ? iso === picker.focusIso : month === 0));
      });
    } else {
      WEEKDAYS.forEach(function(day) { grid.appendChild(el('span', 'run-date-picker-weekday', day)); });
      var offset = (new Date(Date.UTC(picker.year, picker.month, 1)).getUTCDay() + 6) % 7;
      for (var blank = 0; blank < offset; blank += 1) grid.appendChild(el('span', ''));
      var days = new Date(Date.UTC(picker.year, picker.month + 1, 0)).getUTCDate();
      for (var day = 1; day <= days; day += 1) {
        var iso = isoFromParts(picker.year, picker.month, day);
        grid.appendChild(pickerCell(picker, iso, String(day), day + ' ' + MONTHS[picker.month] + ' ' + picker.year,
          focusOnPage ? iso === picker.focusIso : day === 1));
      }
    }

    var footer = el('div', 'run-date-picker-footer');
    var current = currentValue(picker.mode);
    var currentButton = pickerButton('btn btn-sm btn-outline-secondary', monthMode ? 'This month' : 'Today', null, function() { selectDate(picker, current); });
    currentButton.disabled = outOfRange(picker, current);
    footer.append(currentButton, pickerButton('btn btn-sm btn-link', 'Clear', null, function() { selectDate(picker, ''); }));
    picker.panel.replaceChildren(header, grid, footer);
  }

  function openDatePicker(picker) {
    closeDatePicker(false);
    var start = parseValue(picker.mode, picker.input.value) ? picker.input.value : currentValue(picker.mode);
    if (picker.limits.min && start < picker.limits.min) start = picker.limits.min;
    if (picker.limits.max && start > picker.limits.max) start = picker.limits.max;
    picker.panel = el('div', 'run-date-picker shadow');
    picker.panel.id = picker.input.id + '-calendar';
    picker.panel.setAttribute('role', 'dialog');
    picker.panel.setAttribute('aria-label', picker.mode === 'month' ? 'Choose month' : 'Choose date');
    picker.panel.addEventListener('keydown', function(event) {
      if (event.key !== 'Escape') return;
      // Close only the calendar, not the surrounding modal.
      event.preventDefault();
      event.stopPropagation();
      closeDatePicker(true);
    });
    picker.wrapper.append(picker.panel);
    picker.toggle.setAttribute('aria-expanded', 'true');
    activePicker = picker;
    if (document.addEventListener) document.addEventListener('mousedown', picker.outside, true);
    moveFocus(picker, start);
  }

  // Wraps a date or month input in an input group with a calendar button.
  // limits: { min, max } in the ISO format of the mode ("date" or "month").
  function withDatePicker(input, limits, mode) {
    var wrapper = el('div', 'run-date-field');
    var group = el('div', 'input-group');
    var toggle = el('button', 'btn btn-outline-secondary run-date-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', tr('runParameterOpenCalendar'));
    toggle.title = tr('runParameterOpenCalendar');
    toggle.setAttribute('aria-haspopup', 'dialog');
    toggle.setAttribute('aria-expanded', 'false');
    var icon = el('i', 'bi bi-calendar3');
    icon.setAttribute('aria-hidden', 'true');
    toggle.appendChild(icon);
    group.append(input, toggle);
    wrapper.appendChild(group);
    var picker = { input: input, toggle: toggle, wrapper: wrapper, group: group, limits: limits || {}, mode: mode || 'date', buttons: {} };
    picker.outside = function(event) {
      if (!wrapper.contains(event.target)) closeDatePicker(false);
    };
    toggle.addEventListener('click', function() {
      if (activePicker === picker) closeDatePicker(true);
      else openDatePicker(picker);
    });
    input.pickerToggle = toggle;
    wrapper.fieldInput = input;
    return wrapper;
  }

  function selectInput(state, key, choices, onChange) {
    var select = el('select', 'form-select');
    choices.forEach(function(choice) {
      var option = el('option', '', choice[1]);
      option.value = choice[0];
      select.appendChild(option);
    });
    select.value = state[key] || choices[0][0];
    select.addEventListener('change', function() {
      state[key] = select.value;
      if (onChange) onChange();
    });
    return select;
  }

  function checkInput(state, key, id, labelText) {
    var wrapper = el('div', 'form-check');
    var input = el('input', 'form-check-input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = state[key] === true;
    input.addEventListener('change', function() { state[key] = input.checked; });
    var label = el('label', 'form-check-label', labelText);
    label.setAttribute('for', id);
    wrapper.append(input, label);
    return wrapper;
  }

  function renderEditorRow(state, index) {
    var prefix = 'run-parameter-' + index;
    var card = el('div', 'run-parameter-definition');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', tr('runParameterNumber', { number: index + 1 }));

    var header = el('div', 'run-parameter-definition-header');
    header.appendChild(el('span', 'run-parameter-definition-title', state.label || state.flag || tr('runParameterNumber', { number: index + 1 })));
    var actions = el('div', 'btn-group btn-group-sm');
    [['bi-arrow-up', tr('moveArgumentUp'), -1], ['bi-arrow-down', tr('moveArgumentDown'), 1], ['bi-x-lg', tr('removeRunParameter'), 0]].forEach(function(action) {
      var button = el('button', 'btn btn-outline-secondary');
      button.type = 'button';
      button.title = action[1];
      button.setAttribute('aria-label', action[1]);
      var icon = el('i', 'bi ' + action[0]);
      icon.setAttribute('aria-hidden', 'true');
      button.appendChild(icon);
      button.addEventListener('click', function() {
        if (action[2] === 0) editorState.splice(index, 1);
        else {
          var target = index + action[2];
          if (target < 0 || target >= editorState.length) return;
          editorState.splice(target, 0, editorState.splice(index, 1)[0]);
        }
        renderEditor();
      });
      actions.appendChild(button);
    });
    header.appendChild(actions);
    card.appendChild(header);

    var grid = el('div', 'row g-2');
    var flagInput = textInput(state, 'flag', { monospace: true, placeholder: '--date', maxLength: 64 });
    var nameInput = textInput(state, 'name', { monospace: true, placeholder: 'date', maxLength: 32 });
    var nameColumn = editorField(prefix + '-name', tr('runParameterName'), nameInput, 'col-md-4');
    var nameHelp = el('div', 'form-text', tr('runParameterNameHelp'));
    nameHelp.id = prefix + '-name-help';
    nameInput.setAttribute('aria-describedby', nameHelp.id);
    nameColumn.appendChild(nameHelp);
    var refreshName = function() { markNameField(nameInput, nameHelp, state.name !== '' && !validName(state.name)); };
    nameInput.addEventListener('input', refreshName);
    // Fill the name from the argument while it is empty or still the suggestion.
    flagInput.addEventListener('input', function() {
      if (state.name && state.name !== state.suggestedName) return;
      state.suggestedName = nameFromFlag(state.flag);
      state.name = state.suggestedName;
      nameInput.value = state.name;
      refreshName();
    });
    refreshName();
    grid.appendChild(editorField(prefix + '-flag', tr('runParameterFlag'), flagInput, 'col-md-4'));
    grid.appendChild(nameColumn);
    grid.appendChild(editorField(prefix + '-type', tr('runParameterType'), selectInput(state, 'type', TYPES.map(function(type) {
      return [type, tr('runParameterType_' + type)];
    }), function() { state.default = undefined; renderEditor(); }), 'col-md-4'));
    grid.appendChild(editorField(prefix + '-label', tr('runParameterLabel'), textInput(state, 'label', { maxLength: 80 }), 'col-md-6'));
    grid.appendChild(editorField(prefix + '-help', tr('runParameterHelpText'), textInput(state, 'help', { maxLength: 200 }), 'col-md-6'));

    if (isCalendarType(state.type)) {
      var monthType = state.type === 'month';
      grid.appendChild(editorField(prefix + '-min', tr(monthType ? 'runParameterMinMonth' : 'runParameterMinDate'), calendarInput(state, 'min', state.type), 'col-md-4'));
      grid.appendChild(editorField(prefix + '-max', tr(monthType ? 'runParameterMaxMonth' : 'runParameterMaxDate'), calendarInput(state, 'max', state.type), 'col-md-4'));
      grid.appendChild(editorField(prefix + '-default', tr('runParameterDefault'), calendarInput(state, 'default', state.type), 'col-md-4'));
    } else if (state.type === 'integer') {
      grid.appendChild(editorField(prefix + '-min', tr('runParameterMin'), textInput(state, 'min', { type: 'number' }), 'col-md-4'));
      grid.appendChild(editorField(prefix + '-max', tr('runParameterMax'), textInput(state, 'max', { type: 'number' }), 'col-md-4'));
      grid.appendChild(editorField(prefix + '-default', tr('runParameterDefault'), textInput(state, 'default', { type: 'number' }), 'col-md-4'));
    } else if (state.type === 'select') {
      var options = el('textarea', 'form-control font-monospace');
      options.rows = 3;
      options.value = state.optionsText || '';
      options.placeholder = 'full|Full\ndelta|Delta';
      options.addEventListener('input', function() { state.optionsText = options.value; });
      var optionsColumn = editorField(prefix + '-options', tr('runParameterOptions'), options, 'col-md-8');
      optionsColumn.appendChild(el('div', 'form-text', tr('runParameterOptionsHelp')));
      grid.appendChild(optionsColumn);
      grid.appendChild(editorField(prefix + '-default', tr('runParameterDefault'), textInput(state, 'default', { monospace: true }), 'col-md-4'));
    } else if (state.type === 'text') {
      var patternColumn = editorField(prefix + '-pattern', tr('runParameterPattern'), textInput(state, 'pattern', { monospace: true, placeholder: '[A-Z]{2}', maxLength: 256 }), 'col-md-5');
      patternColumn.appendChild(el('div', 'form-text', tr('runParameterPatternHelp')));
      grid.appendChild(patternColumn);
      grid.appendChild(editorField(prefix + '-max-length', tr('runParameterMaxLength'), textInput(state, 'max_length', { type: 'number' }), 'col-md-3'));
      grid.appendChild(editorField(prefix + '-default', tr('runParameterDefault'), textInput(state, 'default', {}), 'col-md-4'));
    }

    if (state.type !== 'flag') {
      grid.appendChild(editorField(prefix + '-style', tr('runParameterStyle'), selectInput(state, 'style', [
        ['separate', tr('runParameterStyle_separate')], ['equals', tr('runParameterStyle_equals')],
      ]), 'col-md-4'));
    }
    grid.appendChild(editorField(prefix + '-role', tr('runParameterMinRole'), selectInput(state, 'min_role', ROLES.map(function(role) {
      return [role, tr(role)];
    })), 'col-md-4'));

    var checks = el('div', 'col-md-4 d-flex flex-column justify-content-end gap-1');
    if (state.type === 'flag') checks.appendChild(checkInput(state, 'default', prefix + '-default', tr('runParameterDefaultOn')));
    else checks.appendChild(checkInput(state, 'required', prefix + '-required', tr('runParameterRequired')));
    checks.appendChild(checkInput(state, 'confirm', prefix + '-confirm', tr('runParameterConfirm')));
    grid.appendChild(checks);

    card.appendChild(grid);
    return card;
  }

  function renderEditor() {
    closeDatePicker(false);
    var container = document.getElementById('job-run-parameters');
    if (!container) return;
    container.replaceChildren();
    editorState.forEach(function(state, index) { container.appendChild(renderEditorRow(state, index)); });
  }

  function addEditorParameter() {
    editorState.push(emptyDefinition());
    renderEditor();
    var input = document.getElementById('run-parameter-' + (editorState.length - 1) + '-flag');
    if (input) input.focus();
  }

  /* ---------------- Manual run form ---------------- */

  var runState = null;

  function fieldId(name) {
    return 'run-param-' + name;
  }

  function collectValues() {
    var values = {};
    runState.definitions.forEach(function(definition) {
      var input = document.getElementById(fieldId(definition.name));
      if (!input || input.disabled) return;
      if (definition.type === 'flag') values[definition.name] = input.checked;
      else if (definition.type === 'integer') values[definition.name] = input.value === '' ? '' : Number(input.value);
      else values[definition.name] = input.value;
    });
    return values;
  }

  function setFieldError(name, message) {
    var error = document.getElementById(fieldId(name) + '-error');
    var input = document.getElementById(fieldId(name));
    if (error) {
      error.textContent = message || '';
      error.classList.toggle('d-none', !message);
    }
    if (input) {
      input.classList.toggle('is-invalid', Boolean(message));
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function setFormError(message) {
    var box = document.getElementById('run-parameters-error');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('d-none', !message);
  }

  function renderConfirmations(active) {
    var container = document.getElementById('run-parameters-confirmations');
    var list = document.getElementById('run-parameters-confirm-list');
    var needed = active.filter(function(parameter) { return parameter.confirm; });
    var previous = {};
    Array.prototype.forEach.call(list.querySelectorAll('input[type="checkbox"]'), function(input) {
      previous[input.dataset.parameter] = input.checked;
    });
    list.replaceChildren();
    needed.forEach(function(parameter) {
      var definition = runState.definitions.find(function(item) { return item.name === parameter.name; });
      var wrapper = el('div', 'form-check');
      var input = el('input', 'form-check-input');
      input.type = 'checkbox';
      input.id = 'run-confirm-' + parameter.name;
      input.dataset.parameter = parameter.name;
      input.checked = previous[parameter.name] === true;
      input.addEventListener('change', updateRunForm);
      var label = el('label', 'form-check-label', tr('runParameterConfirmItem', { label: definition.label, flag: definition.flag }));
      label.setAttribute('for', input.id);
      wrapper.append(input, label);
      list.appendChild(wrapper);
    });
    container.classList.toggle('d-none', !needed.length);
    return needed.map(function(parameter) { return parameter.name; });
  }

  function confirmedNames() {
    return Array.prototype.filter.call(
      document.querySelectorAll('#run-parameters-confirm-list input[type="checkbox"]'),
      function(input) { return input.checked; }
    ).map(function(input) { return input.dataset.parameter; });
  }

  function incompleteDate(name) {
    var definition = runState.definitions.find(function(item) { return item.name === name; });
    var input = document.getElementById(fieldId(name));
    return Boolean(definition && isCalendarType(definition.type) && input && input.value.length > 0
      && input.value.length < CALENDAR_FORMATS[definition.type].length);
  }

  function updateRunForm() {
    var submit = document.getElementById('run-parameters-submit');
    var preview = document.getElementById('run-parameters-preview');
    runState.definitions.forEach(function(definition) { setFieldError(definition.name, ''); });
    setFormError('');
    var resolved;
    try {
      resolved = rules().resolveRunParameters(runState.definitions, collectValues(), runState.fixedArguments);
    } catch (error) {
      // A date still being typed only keeps the submit disabled; it is not an error yet.
      if (error.parameter) {
        if (!incompleteDate(error.parameter)) setFieldError(error.parameter, error.message);
      } else setFormError(error.message);
      renderConfirmations([]);
      preview.textContent = '';
      submit.disabled = true;
      return null;
    }
    var required = renderConfirmations(resolved.active);
    var confirmed = confirmedNames();
    preview.textContent = JSON.stringify(runState.commandPrefix.concat(resolved.arguments), null, 2);
    var blocked = resolved.active.some(function(parameter) { return !allowedForRole(parameter); });
    if (blocked) setFormError(tr('runParameterDefaultBlocked'));
    submit.disabled = blocked || required.some(function(name) { return confirmed.indexOf(name) === -1; });
    return resolved;
  }

  function renderRunField(definition, initialValues) {
    var group = el('div', 'run-parameter-field');
    var id = fieldId(definition.name);
    var allowed = allowedForRole(definition);
    var hasInitial = initialValues && Object.prototype.hasOwnProperty.call(initialValues, definition.name);
    // Repeating a run: values absent from that run were inactive, so they stay off rather than
    // falling back to the current defaults.
    var value = initialValues
      ? (hasInitial ? initialValues[definition.name] : (definition.type === 'flag' ? false : null))
      : definition.default;
    var described = [];
    var input;

    if (definition.type === 'flag') {
      var check = el('div', 'form-check');
      input = el('input', 'form-check-input');
      input.type = 'checkbox';
      input.checked = value === true;
      var checkLabel = el('label', 'form-check-label', definition.label + ' ');
      checkLabel.setAttribute('for', id);
      checkLabel.appendChild(el('code', '', definition.flag));
      check.append(input, checkLabel);
      group.appendChild(check);
    } else {
      var label = el('label', 'form-label', definition.label + (definition.required ? ' *' : ''));
      label.setAttribute('for', id);
      group.appendChild(label);
      if (definition.type === 'select') {
        input = el('select', 'form-select');
        if (!definition.required) {
          var none = el('option', '', tr('runParameterNoValue'));
          none.value = '';
          input.appendChild(none);
        }
        definition.options.forEach(function(choice) {
          var option = el('option', '', choice.label);
          option.value = choice.value;
          input.appendChild(option);
        });
      } else {
        input = el('input', 'form-control');
        if (isCalendarType(definition.type)) {
          isoCalendarInput(input, definition.type);
        } else if (definition.type === 'integer') {
          input.type = 'number';
          input.step = '1';
          input.min = String(definition.min);
          input.max = String(definition.max);
          input.inputMode = 'numeric';
        } else {
          input.type = 'text';
          input.maxLength = definition.max_length;
          input.classList.add('font-monospace');
        }
      }
      input.value = value === null || value === undefined ? '' : String(value);
      if (definition.required) input.required = true;
      group.appendChild(isCalendarType(definition.type)
        ? withDatePicker(input, { min: definition.min, max: definition.max }, definition.type) : input);
      var flagHint = el('div', 'form-text', tr('runParameterArgument', { flag: definition.flag }));
      flagHint.id = id + '-flag';
      described.push(flagHint.id);
      group.appendChild(flagHint);
    }
    input.id = id;
    input.name = definition.name;
    if (definition.help) {
      var help = el('div', 'form-text', definition.help);
      help.id = id + '-help';
      described.push(help.id);
      group.appendChild(help);
    }
    if (!allowed) {
      input.disabled = true;
      if (input.pickerToggle) input.pickerToggle.disabled = true;
      var role = el('div', 'form-text text-warning-emphasis', tr('runParameterRequiresRole', { role: tr(definition.min_role) }));
      role.id = id + '-role';
      described.push(role.id);
      group.appendChild(role);
    }
    var error = el('div', 'invalid-feedback d-block d-none');
    error.id = id + '-error';
    error.setAttribute('role', 'alert');
    described.push(error.id);
    group.appendChild(error);
    input.setAttribute('aria-describedby', described.join(' '));
    input.addEventListener(definition.type === 'flag' || definition.type === 'select' ? 'change' : 'input', updateRunForm);
    return group;
  }

  // Opens the run form for a task with run parameters.
  // options: { environment, initialValues, onStarted(operationId), runUrl }
  function openRunForm(job, options) {
    var execution = job.structured_execution || {};
    runState = {
      job: job,
      definitions: rules().validateRunParameterDefinitions(execution.run_parameters || [], execution.arguments || []),
      fixedArguments: execution.arguments || [],
      commandPrefix: (options.environment ? [options.environment.executable_path] : []).concat([execution.script_path]),
      onStarted: options.onStarted,
      runUrl: options.runUrl,
    };
    var subtitle = [job.name || job._id];
    if (options.environment) subtitle.push(options.environment.runtime_type, options.environment.target_id);
    document.getElementById('run-parameters-task').textContent = subtitle.join(' · ');
    var fields = document.getElementById('run-parameters-fields');
    closeDatePicker(false);
    fields.replaceChildren();
    runState.definitions.forEach(function(definition) {
      fields.appendChild(renderRunField(definition, options.initialValues));
    });
    document.getElementById('run-parameters-confirm-list').replaceChildren();
    updateRunForm();
    var modalElement = document.getElementById('run-parameters-modal');
    bootstrap.Modal.getOrCreateInstance(modalElement).show();
    var first = fields.querySelector('input:not([disabled]), select:not([disabled])');
    if (first) modalElement.addEventListener('shown.bs.modal', function focusFirst() {
      modalElement.removeEventListener('shown.bs.modal', focusFirst);
      first.focus();
    });
  }

  function submitRunForm(event) {
    event.preventDefault();
    if (!runState) return;
    var resolved = updateRunForm();
    if (!resolved) return;
    var submit = document.getElementById('run-parameters-submit');
    submit.disabled = true;
    var state = runState;
    $.ajax({
      url: state.runUrl,
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({ _id: state.job._id, parameters: collectValues(), confirmed: confirmedNames() }),
    }).done(function(result) {
      bootstrap.Modal.getOrCreateInstance(document.getElementById('run-parameters-modal')).hide();
      if (state.onStarted) state.onStarted(result.operationId);
    }).fail(function(response) {
      var body = response && response.responseJSON ? response.responseJSON : {};
      var message = body.message || (response && response.statusText) || tr('error');
      if (body.parameter && document.getElementById(fieldId(body.parameter))) setFieldError(body.parameter, message);
      else setFormError(message);
      submit.disabled = false;
    });
  }

  function bind() {
    var add = document.getElementById('job-add-run-parameter');
    if (add) add.addEventListener('click', addEditorParameter);
    var form = document.getElementById('run-parameters-form');
    if (form) form.addEventListener('submit', submitRunForm);
  }

  var api = {
    init: init,
    bind: bind,
    allowedForRole: allowedForRole,
    formatValues: formatValues,
    fillEditor: fillEditor,
    readEditor: readEditor,
    checkEditor: checkEditor,
    setEditorTarget: setEditorTarget,
    textToOptions: textToOptions,
    optionsToText: optionsToText,
    openRunForm: openRunForm,
    hasRunParameters: function(job) {
      return Boolean(job && job.execution_mode === 'structured' && job.structured_execution
        && Array.isArray(job.structured_execution.run_parameters) && job.structured_execution.run_parameters.length);
    },
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrontabRunParameters = api;
})(typeof window !== 'undefined' ? window : globalThis);
