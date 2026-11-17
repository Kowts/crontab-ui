/* Run parameters: task editor section, manual run form and history formatting (SDD v0.8.0).
 * Validation and argv composition reuse the server rules served as CrontabRunParameterRules,
 * so the preview shows exactly what the server composes. The server always validates again. */
(function(root) {
  var ROLE_LEVEL = { viewer: 0, executor: 1, operator: 2, admin: 3 };
  var TYPES = ['flag', 'date', 'select', 'integer', 'text'];
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
      if (state.type === 'date') {
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
    control.id = id;
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

  // Dates are typed as ISO YYYY-MM-DD, the exact value the script receives. The native date
  // control is avoided because it shows the browser's regional format (e.g. dd/mm/yyyy).
  function maskIsoDate(value) {
    var digits = String(value || '').replace(/\D/g, '').slice(0, 8);
    if (digits.length > 6) return digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6);
    if (digits.length > 4) return digits.slice(0, 4) + '-' + digits.slice(4);
    return digits;
  }

  // Configures a text input for ISO dates. Must run before other input listeners are added,
  // so they read the masked value.
  function isoDateInput(input) {
    input.type = 'text';
    input.placeholder = 'YYYY-MM-DD';
    input.maxLength = 10;
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.classList.add('font-monospace');
    input.addEventListener('input', function() {
      var masked = maskIsoDate(input.value);
      if (masked !== input.value) input.value = masked;
    });
    return input;
  }

  function dateInput(state, key) {
    var input = isoDateInput(el('input', 'form-control'));
    input.value = state[key] === undefined || state[key] === null ? '' : String(state[key]);
    input.addEventListener('input', function() { state[key] = input.value; });
    return input;
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

    if (state.type === 'date') {
      grid.appendChild(editorField(prefix + '-min', tr('runParameterMinDate'), dateInput(state, 'min'), 'col-md-4'));
      grid.appendChild(editorField(prefix + '-max', tr('runParameterMaxDate'), dateInput(state, 'max'), 'col-md-4'));
      grid.appendChild(editorField(prefix + '-default', tr('runParameterDefault'), dateInput(state, 'default'), 'col-md-4'));
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
    return Boolean(definition && definition.type === 'date' && input && input.value.length > 0 && input.value.length < 10);
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
        if (definition.type === 'date') {
          isoDateInput(input);
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
      group.appendChild(input);
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
