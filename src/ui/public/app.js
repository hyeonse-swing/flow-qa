(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const i18n = window.FlowQAI18n;
  const t = i18n.t;
  const names = { scenario: 'nav.scenario', library: 'nav.library', history: 'nav.history', settings: 'nav.settings' };
  const app = { state: null, connected: false, displayTargets: [], draft: null, selectedCaseIds: new Set(), script: '', savedFile: '', savedHash: '', origin: 'none', sourceFlow: '', boundSource: null, stale: false, dirty: false, busy: false, planning: false, planRequest: 0, stopping: false, report: null, reportMarkdown: '', selectedRun: '', rerunOrigin: null, rerunTargetMismatch: false, navigationVersion: 0, comparison: null, comparisonRequest: 0, comparisonBusy: false, comparisonStatus: 'comparison.selectBoth', view: 'scenario' };

  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function replace(node, ...children) { node.replaceChildren(...children); }
  function notice(message, error = false, translation = null) {
    const node = $('notice');
    node.textContent = message;
    node.className = error ? 'notice error' : 'notice';
    node.hidden = !message;
    app.notice = translation ? { ...translation, error } : null;
    if (message) node.scrollIntoView({ block: 'nearest' });
  }
  function noticeKey(key, params = {}, error = false) { notice(t(key, params), error, { key, params }); }
  function localizedError(key, params = {}) { const error = new Error(t(key, params)); error.translation = { key, params }; return error; }
  function showError(error) { if (error?.translation) noticeKey(error.translation.key, error.translation.params, true); else notice(error instanceof Error ? error.message : String(error), true); }
  function formatDate(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value || '') : d.toLocaleString(i18n.locale() === 'ko' ? 'ko-KR' : 'en-US'); }
  function download(filename, value, mime = 'text/plain') {
    const url = URL.createObjectURL(new Blob([value], { type: `${mime};charset=utf-8` }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function api(path, body) {
    const options = { headers: { 'Accept-Language': i18n.locale() } };
    if (body !== undefined) { options.method = 'POST'; options.headers['content-type'] = 'application/json'; options.headers['x-flowqa-token'] = app.state?.csrfToken || ''; options.body = JSON.stringify(body); }
    const response = await fetch(path, options);
    let result;
    try { result = await response.json(); } catch { throw localizedError('app.responseUnreadable', { status: response.status }); }
    if (!response.ok) {
      const issues = Array.isArray(result?.issues) ? result.issues.slice(0, 8).map((issue) => `${issue.path}: ${issue.message}`).join('\n') : '';
      if (!result?.error && !issues) throw localizedError('app.requestFailed', { status: response.status });
      throw new Error(`${result?.error || t('app.requestFailed', { status: response.status })}${issues ? `\n${issues}` : ''}`);
    }
    return result;
  }
  function view(name) {
    app.navigationVersion += 1;
    app.view = name;
    for (const key of Object.keys(names)) $('view-' + key).hidden = key !== name;
    document.querySelectorAll('[data-view]').forEach((button) => {
      const chosen = button.dataset.view === name;
      button.classList.toggle('selected', chosen);
      if (chosen) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $('breadcrumb').textContent = t('app.breadcrumb', { name: t(names[name]) });
    $('sidebar').classList.remove('nav-open'); $('nav-toggle').setAttribute('aria-expanded', 'false');
    if (name === 'history') { renderHistory(); renderComparisonOptions(); }
  }
  function suitePlatform() { return app.draft?.platform || 'web'; }
  function targetPlatform(target) { return target?.kind === 'mobile' ? 'mobile' : 'web'; }
  function selectedTarget() { return app.displayTargets.find((target) => target.name === $('target-select').value); }
  function targetLabel(target) { return target?.kind === 'mobile' ? `${target.platform === 'ios' ? 'iOS' : 'Android'} · ${target.bundleId} · ${target.device}` : target?.url || ''; }
  function targetDisplay(target) { return `${target?.name || t('app.noTarget')} · ${targetLabel(target)}`; }
  function compatibleTarget() { const target = selectedTarget(); return target && targetPlatform(target) === suitePlatform(); }
  function selectedCases() { return (app.draft?.cases || []).filter((item) => app.selectedCaseIds.has(item.id)); }
  function selectionScope(selection) {
    return selection && Array.isArray(selection.caseIds) && Number.isInteger(selection.totalCases) && selection.caseIds.length < selection.totalCases
      ? t('app.selectedScope', { selected: selection.caseIds.length, total: selection.totalCases }) : '';
  }
  function renderCaseSelection() {
    const host = $('case-selection-list'); replace(host);
    for (const item of app.draft?.cases || []) {
      const label = el('label', 'case-selection-item');
      const input = el('input'); input.type = 'checkbox'; input.dataset.caseId = item.id; input.checked = app.selectedCaseIds.has(item.id);
      label.append(input, el('span', '', `${item.id} · ${item.title}`)); host.append(label);
    }
    updateCaseSelection();
  }
  function updateCaseSelection() {
    const total = app.draft?.cases?.length || 0;
    $('case-selection-summary').textContent = t('scenario.selectionSummary', { selected: selectedCases().length, total });
    const disabled = !app.draft || app.busy || !!app.state?.active;
    for (const input of $('case-selection-list').querySelectorAll('input[data-case-id]')) {
      input.checked = app.selectedCaseIds.has(input.dataset.caseId);
      input.disabled = disabled;
    }
    $('select-all-cases').disabled = disabled || selectedCases().length === total;
    $('clear-case-selection').disabled = disabled || !app.selectedCaseIds.size;
  }
  function changeCaseSelection(ids) {
    if (!app.draft || app.busy || app.state?.active) return;
    const next = new Set(ids);
    if (next.size === app.selectedCaseIds.size && [...next].every((id) => app.selectedCaseIds.has(id))) return;
    app.selectedCaseIds = next; $('review-checkbox').checked = false; readiness();
  }
  function canDownloadSavedCases() {
    return Boolean(app.draft && app.script && app.savedFile && app.savedHash && !app.dirty && !app.stale && !app.busy && !hasUnsavedScenario());
  }
  function canDownloadSourceMarkdown() { return canDownloadSavedCases() && Boolean(app.draft.source); }
  function readiness() {
    const active = app.state?.active;
    const ready = !!app.draft && !!app.script && !app.stale && !app.dirty;
    $('run-btn').disabled = !app.connected || !ready || !app.savedFile || !app.savedHash || !selectedCases().length || !$('review-checkbox').checked || !compatibleTarget() || !!active || app.busy;
    updateCaseSelection();
    $('save-btn').disabled = !ready || app.busy;
    $('suite-download').disabled = !canDownloadSavedCases();
    $('flow-download').disabled = !canDownloadSourceMarkdown();
    $('script-download').disabled = !ready;
    for (const id of ['stop-btn', 'global-stop-btn']) {
      $(id).hidden = !active;
      $(id).disabled = !app.connected || !active || active.status === 'stopping' || app.stopping;
      $(id).textContent = t(active?.kind === 'plan' ? 'app.stopPlan' : 'scenario.stop');
    }
    $('plan-btn').disabled = !app.connected || !app.state?.models?.planner?.configured || app.state.models.planner.kind !== 'openai-compatible' || !app.state.models.planner.keyReady || !!active || app.busy;
    $('compile-btn').disabled = app.stale || app.busy;
    $('new-draft-btn').disabled = app.busy;
    $('import-btn').disabled = app.busy;
    $('import-json').disabled = app.busy;
    $('import-markdown').disabled = app.busy;
    $('flow-input').disabled = app.busy;
    $('suite-editor').disabled = app.busy;
    $('prompt-btn').disabled = app.busy;
    $('scenario-platform').disabled = app.busy;
    $('target-select').disabled = app.busy;
    $('review-checkbox').disabled = app.busy;
    $('report-rerun').disabled = !app.connected || !!active || app.busy || !app.selectedRun || !(app.report?.cases || []).some((item) => item.status === 'failed' || item.status === 'error');
    $('mobile-setup-hint').hidden = suitePlatform() !== 'mobile' && $('scenario-platform').value !== 'mobile';
    $('run-readiness').textContent = t(!app.connected ? 'app.connectionRequired'
      : active ? (active.status === 'stopping' ? 'app.stopping' : active.kind === 'plan' ? 'app.planning' : 'app.running')
      : app.stale ? 'app.stale'
      : app.dirty ? 'app.dirty'
      : !ready ? 'app.needValidated'
      : !app.savedFile || !app.savedHash ? 'app.needSaved'
      : !selectedCases().length ? 'app.needCaseSelection'
      : !$('target-select').value ? 'app.needTarget'
      : !compatibleTarget() ? 'app.platformMismatch'
      : !$('review-checkbox').checked ? 'app.needReview' : 'app.ready');
    const cases = selectedCases();
    const blocked = cases.filter((item) => item.questions?.length || (item.steps.some((step) => ['act', 'assertAgent'].includes(step.type)) && !app.state?.models?.agent?.keyReady)).length;
    $('case-readiness').textContent = ready ? t(cases.length < (app.draft?.cases.length || 0) ? 'app.selectedCaseReadiness' : 'app.caseReadiness', { total: cases.length, ready: cases.length - blocked, blocked, hint: blocked ? t('app.blockedHint') : '' }) : '';
    const pill = $('draft-status');
    pill.textContent = t(app.stale ? 'app.regenerate' : app.dirty ? 'app.revalidate' : ready ? 'app.validated' : 'scenario.noDraft');
    pill.className = 'status-pill' + (ready ? ' ready' : app.stale || app.dirty ? ' dirty' : '');
    $('draft-source').textContent = t(app.origin === 'generated' ? 'app.sourceGenerated' : app.origin === 'library' ? (app.sourceFlow ? 'app.sourceLibraryFlow' : 'app.sourceLibrary') : app.origin === 'imported' ? (app.sourceFlow ? 'app.sourceImportedFlow' : 'app.sourceImported') : app.origin === 'manual' ? (app.sourceFlow ? 'app.sourceManualFlow' : 'app.sourceManual') : 'scenario.sourceNone');
    $('script-preview').textContent = ready ? app.script : t('scenario.scriptPlaceholder');
  }
  function locatorText(locator) {
    if (!locator) return '';
    const labels = { role: 'app.locatorRole', text: 'app.locatorText', label: 'app.locatorLabel', testId: 'app.locatorTestId' };
    return `${labels[locator.by] ? t(labels[locator.by]) : locator.by} “${locator.value}”${locator.name ? ` · ${t('app.locatorName', { name: locator.name })}` : ''}`;
  }
  function stepText(step) {
    const target = locatorText(step.locator);
    switch (step.type) {
      case 'open': return t('app.stepOpen', { path: step.path });
      case 'launchApp': return t('app.stepLaunchApp');
      case 'back': return t('app.stepBack');
      case 'swipe': return t('app.stepSwipe', { direction: step.direction });
      case 'click': return t('app.stepClick', { target });
      case 'fill': return t('app.stepFill', { target, value: step.value });
      case 'assertVisible': return t(step.visible === false ? 'app.stepHidden' : 'app.stepVisible', { target });
      case 'assertText': return t(step.match === 'contains' ? 'app.stepTextContains' : 'app.stepTextEquals', { target, expected: step.expected });
      case 'assertUrl': return t('app.stepUrl', { expected: step.expected });
      case 'act': return t('app.stepAct', { instruction: step.instruction });
      case 'assertAgent': return t('app.stepAssertAgent', { instruction: step.instruction });
      default: return step.type;
    }
  }
  function summarize(suite, preserveOpen = false) {
    const host = $('draft-summary');
    const openCases = preserveOpen ? [...host.querySelectorAll('.case-review')].map((node) => node.open) : null;
    replace(host);
    if (!suite) { host.append(el('p', 'summary-empty', t('scenario.summaryEmpty'))); return; }
    const title = el('h3', '', suite.title || t('app.untitledSuite')); host.append(title);
    const metrics = el('div', 'summary-grid');
    for (const [number, key] of [[suite.cases?.length || 0, 'app.cases'], [suite.requirements?.length || 0, 'app.requirements'], [suite.cases?.reduce((n, item) => n + (item.questions?.length || 0), 0) || 0, 'app.questions']]) {
      const item = el('div', 'summary-stat'); item.append(el('strong', '', number), el('span', '', t(key))); metrics.append(item);
    }
    host.append(metrics);
    const reqTitle = el('h3', '', t('app.requirements')); host.append(reqTitle);
    const reqList = el('ol', 'compact-list'); for (const req of suite.requirements || []) reqList.append(el('li', '', `${req.id} · ${req.text}`)); host.append(reqList);
    host.append(el('h3', 'case-title', t('app.caseSteps')));
    const cases = suite.cases || [];
    if (cases.length) {
      const actions = el('div', 'actions');
      const expand = el('button', 'button quiet', t('scenario.expandCases')); expand.type = 'button'; expand.id = 'expand-cases';
      expand.addEventListener('click', () => host.querySelectorAll('details.case-review').forEach((detail) => { detail.open = true; }));
      const collapse = el('button', 'button quiet', t('scenario.collapseCases')); collapse.type = 'button'; collapse.id = 'collapse-cases';
      collapse.addEventListener('click', () => host.querySelectorAll('details.case-review').forEach((detail) => { detail.open = false; }));
      actions.append(expand, collapse); host.append(actions);
    }
    for (const [index, item] of cases.entries()) {
      const detail = el('details', 'case-review'); detail.open = openCases ? !!openCases[index] : index === 0;
      detail.append(el('summary', '', `${item.id} · ${item.title}${item.questions?.length ? ` · ${t('app.caseBlocked')}` : ''}`));
      detail.append(el('p', 'hint', t('app.linkedRequirements', { ids: (item.requirementIds || []).join(', ') || t('app.none') })));
      if (item.preconditions?.length) { detail.append(el('h4', '', t('app.preconditions'))); const list = el('ul', 'compact-list'); for (const value of item.preconditions) list.append(el('li', '', value)); detail.append(list); }
      const steps = el('ol', 'compact-list case-steps');
      for (const step of item.steps || []) steps.append(el('li', step.type.startsWith('assert') ? 'expected-step' : '', stepText(step)));
      detail.append(steps);
      if (item.questions?.length) { detail.append(el('h4', 'blocked-title', t('app.blockingQuestions'))); const list = el('ul', 'compact-list'); for (const value of item.questions) list.append(el('li', '', value)); detail.append(list); }
      host.append(detail);
    }
  }
  function setDraft(suite, script, origin, sourceFlow = '', savedFile = '', savedHash = '') {
    app.rerunOrigin = null; app.rerunTargetMismatch = false; renderRerunHints();
    app.draft = suite; app.script = script; app.origin = origin; app.sourceFlow = sourceFlow; app.boundSource = suite.source ? { ...suite.source } : null; app.savedFile = savedFile; app.savedHash = savedHash; app.stale = false; app.dirty = false;
    $('suite-editor').value = JSON.stringify(suite, null, 2);
    $('scenario-platform').value = suite.platform || 'web';
    $('review-checkbox').checked = false;
    app.selectedCaseIds = new Set((suite.cases || []).map((item) => item.id));
    summarize(suite); renderCaseSelection(); readiness();
  }
  function targetOptions() {
    const selected = $('target-select').value;
    const previousFingerprint = app.displayTargets.find((item) => item.name === selected)?.targetFingerprint;
    app.displayTargets = (app.state?.targets || []).map((target) => ({ ...target }));
    replace($('target-select'), el('option', '', t('scenario.selectTarget')));
    $('target-select').firstChild.value = '';
    for (const target of app.state?.targets || []) { const option = el('option', '', targetDisplay(target)); option.value = target.name; $('target-select').append(option); }
    if ((app.state?.targets || []).some((x) => x.name === selected)) $('target-select').value = selected;
    if (previousFingerprint !== app.displayTargets.find((item) => item.name === selected)?.targetFingerprint) $('review-checkbox').checked = false;
    targetDescription();
    const list = $('target-list'); replace(list);
    for (const target of app.state?.targets || []) { const row = el('div', 'settings-entry'); row.append(el('strong', '', target.name), document.createTextNode(` · ${targetLabel(target)}${target.description ? ` · ${target.description}` : ''}`)); list.append(row); }
  }
  function targetDescription() { const target = selectedTarget(); $('target-description').textContent = target ? `${targetLabel(target)}${target.description ? ` · ${target.description}` : ''}` : t('scenario.targetHint'); readiness(); }
  function renderRerunHints() {
    $('rerun-origin-hint').hidden = !app.rerunOrigin;
    if (app.rerunOrigin) $('rerun-origin-hint').textContent = t('app.rerunPrepared', app.rerunOrigin);
    $('rerun-target-hint').hidden = !app.rerunTargetMismatch;
    if (app.rerunTargetMismatch) $('rerun-target-hint').textContent = t('app.rerunTargetMismatch');
  }
  function modelDescription(role) {
    const model = app.state?.models?.[role] || {};
    const explanation = t(role === 'planner' ? 'app.modelPlannerHelp' : 'app.modelAgentHelp');
    if (!model.configured) return `${explanation} ${t('app.modelUnconnected')}`;
    if (model.kind === 'external') return `${explanation} ${t('app.modelExternal')}`;
    const keyState = !model.apiKeyEnv ? 'app.modelNoKey' : model.keyReady ? 'app.modelKeyReady' : 'app.modelKeyMissing';
    return `${explanation} ${model.model || t('app.modelGeneric')} · ${t(keyState)} · ${t('app.modelUnverified')}`;
  }
  function modelForms() {
    const host = $('model-forms'); replace(host);
    for (const role of ['planner', 'agent']) {
      const model = app.state?.models?.[role] || {};
      const section = el('section', 'model-block'); section.dataset.role = role; section.append(el('h3', '', t(role === 'planner' ? 'app.modelPlanner' : 'app.modelAgent')));
      section.append(el('p', 'model-description', modelDescription(role)));
      if (model.kind === 'external') { host.append(section); continue; }
      const form = el('form', 'model-form'); form.dataset.role = role;
      for (const [name, titleKey, placeholder, value] of [['baseURL', 'app.modelBaseUrl', 'https://example.com/v1', model.baseURL || ''], ['model', 'app.modelName', t('app.modelIdentifier'), model.model || ''], ['apiKeyEnv', 'app.modelKeyEnv', 'OPENAI_API_KEY', model.apiKeyEnv || '']]) {
        const labelNode = el('label'); labelNode.append(el('span', '', t(titleKey))); const input = el('input'); input.name = name; input.value = value; input.placeholder = placeholder; input.required = name !== 'apiKeyEnv'; input.autocomplete = 'off'; if (name === 'baseURL') input.type = 'url'; if (name === 'apiKeyEnv') input.pattern = '[A-Z][A-Z0-9_]*'; labelNode.append(input); form.append(labelNode);
      }
      const actions = el('div', 'actions'); const save = el('button', 'button primary', t('app.saveConnection')); save.type = 'submit'; actions.append(save);
      if (model.configured) { const clear = el('button', 'button', t('app.clearConnection')); clear.type = 'button'; clear.addEventListener('click', () => clearModel(role)); actions.append(clear); }
      form.append(actions); form.addEventListener('submit', saveModel); section.append(form); host.append(section);
    }
  }
  function renderLibrary() {
    const host = $('library-list'); replace(host);
    const suites = app.state?.suites || [];
    if (!suites.length) { host.append(el('p', 'empty', t('app.libraryEmpty'))); return; }
    const query = $('library-search').value.trim().toLowerCase();
    const matchingSuites = suites.filter((suite) => !query || [suite.title, suite.id, suite.file].some((field) => String(field || '').toLowerCase().includes(query)));
    if (!matchingSuites.length) { host.append(el('p', 'empty', t('app.libraryNoMatches'))); return; }
    for (const suite of matchingSuites) {
      const row = el('div', 'list-row'); const copy = el('div'); copy.append(el('strong', '', suite.title || suite.id), el('small', '', t('app.libraryMeta', { id: suite.id, count: suite.caseCount, questions: suite.questionCount, file: suite.file })));
      const button = el('button', 'button', t('app.load')); button.type = 'button'; button.addEventListener('click', () => loadSuite(suite.file)); row.append(copy, button); host.append(row);
    }
  }
  function renderHistory() {
    const host = $('history-list'); replace(host);
    const runs = app.state?.runs || [];
    if (!runs.length) { host.append(el('p', 'empty', t(app.state?.active ? 'app.historyActiveEmpty' : 'app.historyEmpty'))); return; }
    const status = $('history-status-filter').value;
    const query = $('history-search').value.trim().toLowerCase();
    const matchingRuns = runs.filter((run) => {
      const matchesStatus = !status || run.status === status;
      const matchesSearch = !query || [run.suiteId, run.runId, run.target?.name]
        .some((field) => String(field ?? '').toLowerCase().includes(query));
      return matchesStatus && matchesSearch;
    });
    if (!matchingRuns.length) { host.append(el('p', 'empty', t(query ? 'app.historyNoSearchMatches' : 'app.historyNoStatusMatches'))); return; }
    for (const run of matchingRuns) {
      const row = el('div', 'list-row'); const copy = el('div'); copy.append(el('strong', '', `${run.suiteId} · ${i18n.status(run.status)}`), el('small', '', t('app.runMeta', { date: formatDate(run.startedAt), target: targetDisplay(run.target), passed: run.passedCount ?? 0, total: run.caseCount ?? 0, id: run.runId })));
      const scope = selectionScope(run.selection); if (scope) copy.append(el('small', 'selection-scope', scope));
      const button = el('button', 'button', t('app.viewReport')); button.type = 'button'; button.disabled = run.status === 'running' || run.status === 'stopping'; button.addEventListener('click', () => loadReport(run.runId)); row.append(copy, button); host.append(row);
    }
  }
  const comparisonCategories = ['newly-failed', 'now-passed', 'changed', 'unchanged', 'added', 'missing'];
  const comparisonCategoryKeys = { 'newly-failed': 'comparison.newlyFailed', 'now-passed': 'comparison.nowPassed', changed: 'comparison.changed', unchanged: 'comparison.unchanged', added: 'comparison.added', missing: 'comparison.missing' };
  const comparisonWarningKeys = { 'suite-changed': 'comparison.warningSuite', 'reverse-order': 'comparison.warningReverse', 'incomplete-run': 'comparison.warningIncomplete', 'mobile-identity-unverified': 'comparison.warningMobileIdentity', 'partial-run': 'comparison.warningPartial', 'selection-changed': 'comparison.warningSelectionChanged' };
  function comparisonPair() { return { baseline: $('compare-baseline').value, current: $('compare-current').value }; }
  function comparisonValid() { const { baseline, current } = comparisonPair(); return !!baseline && !!current && baseline !== current; }
  function comparisonStatus(key, params = {}, error = false) {
    app.comparisonStatus = key; app.comparisonStatusParams = params;
    const node = $('comparison-status'); node.textContent = t(key, params); node.classList.toggle('report-errors', error);
  }
  function comparisonControls() {
    const { baseline, current } = comparisonPair();
    $('compare-btn').disabled = !comparisonValid() || app.comparisonBusy;
    $('compare-swap').disabled = !baseline || !current || baseline === current;
    const ready = !!app.comparison && comparisonValid() && app.comparison.baseline.runId === baseline && app.comparison.current.runId === current;
    for (const id of ['comparison-md', 'comparison-json', 'compare-open-baseline', 'compare-open-current']) $(id).disabled = !ready;
    $('comparison-results').hidden = !ready;
  }
  function clearComparison() {
    app.comparisonRequest += 1; app.comparisonBusy = false; app.comparison = null; app.comparisonMarkdown = '';
    $('comparison-summary').replaceChildren(); $('comparison-warnings').replaceChildren(); $('comparison-content').replaceChildren();
    comparisonStatus('comparison.selectBoth'); comparisonControls();
  }
  function renderComparisonOptions() {
    const runs = (app.state?.runs || []).slice(0, 50);
    let missing = false;
    for (const id of ['compare-baseline', 'compare-current']) {
      const select = $(id); const selected = select.value;
      select.replaceChildren(el('option', '', t('comparison.choose'))); select.firstChild.value = '';
      for (const run of runs) {
        const option = el('option', '', `${t('comparison.runLabel', { id: run.runId, shortId: run.runId.slice(-8), date: formatDate(run.startedAt), suite: run.suiteId, target: targetDisplay(run.target), status: i18n.status(run.status) })}${selectionScope(run.selection) ? ` · ${selectionScope(run.selection)}` : ''}`);
        option.value = run.runId; select.append(option);
      }
      select.value = runs.some((run) => run.runId === selected) ? selected : '';
      if (selected && !select.value) missing = true;
    }
    if (missing) clearComparison();
    if (!runs.length && !app.comparison) comparisonStatus('comparison.noRuns');
    comparisonControls();
  }
  async function compareRuns() {
    if (!comparisonValid()) return;
    const { baseline, current } = comparisonPair(); const locale = i18n.locale(); const request = ++app.comparisonRequest;
    app.comparisonBusy = true; app.comparison = null; app.comparisonMarkdown = '';
    comparisonStatus('comparison.loading'); comparisonControls();
    try {
      const result = await api(`/api/comparison?baseline=${encodeURIComponent(baseline)}&current=${encodeURIComponent(current)}`);
      if (request !== app.comparisonRequest || locale !== i18n.locale() || baseline !== $('compare-baseline').value || current !== $('compare-current').value) return;
      app.comparison = result.comparison; app.comparisonMarkdown = result.markdown;
      comparisonStatus('comparison.ready'); renderComparison();
    } catch (error) {
      if (request === app.comparisonRequest && locale === i18n.locale() && baseline === $('compare-baseline').value && current === $('compare-current').value) comparisonStatus('comparison.error', { message: error instanceof Error ? error.message : String(error) }, true);
    } finally { if (request === app.comparisonRequest) { app.comparisonBusy = false; comparisonControls(); } }
  }
  function renderComparison() {
    const result = app.comparison; if (!result) { comparisonControls(); return; }
    const warnings = $('comparison-warnings'); replace(warnings);
    for (const code of result.warnings || []) warnings.append(el('p', 'comparison-warning', t(comparisonWarningKeys[code] || 'comparison.warningUnknown', { code })));
    const summary = $('comparison-summary'); replace(summary);
    const meta = el('p', 'comparison-meta', `${result.baseline.runId} · ${formatDate(result.baseline.startedAt)}${selectionScope(result.baseline.selection) ? ` · ${selectionScope(result.baseline.selection)}` : ''} → ${result.current.runId} · ${formatDate(result.current.startedAt)}${selectionScope(result.current.selection) ? ` · ${selectionScope(result.current.selection)}` : ''}`); summary.append(meta);
    const counts = el('div', 'comparison-counts');
    for (const category of comparisonCategories) {
      const item = el('div', 'comparison-count');
      item.append(el('strong', '', String(result.counts?.[category] ?? 0)), el('span', '', t(comparisonCategoryKeys[category]))); counts.append(item);
    }
    summary.append(counts);
    const host = $('comparison-content'); replace(host);
    const selected = $('comparison-filter').value;
    const cases = (result.cases || []).filter((item) => !selected || item.category === selected);
    if (!cases.length) host.append(el('p', 'empty', t('comparison.noCases')));
    for (const item of cases) {
      const section = el('section', 'case-report comparison-case'); section.dataset.category = item.category;
      section.append(el('h3', '', `${item.id} · ${t(comparisonCategoryKeys[item.category] || 'comparison.changed')} · ${t('comparison.pair', { baseline: item.baseline ? i18n.status(item.baseline.status) : t('comparison.notPresent'), current: item.current ? i18n.status(item.current.status) : t('comparison.notPresent') })}`));
      for (const [side, entry] of [['baseline', item.baseline], ['current', item.current]]) {
        if (!entry) continue;
        section.append(el('p', '', t(side === 'baseline' ? 'comparison.baselineCase' : 'comparison.currentCase', { title: entry.title, status: i18n.status(entry.status) })));
        if (entry.expected?.length) { const list = el('ul', 'compact-list'); for (const value of entry.expected) list.append(el('li', '', String(value))); section.append(el('p', '', t('app.expected')), list); }
        if (entry.reason) section.append(el('p', '', t('comparison.reason', { value: entry.reason })));
      }
      host.append(section);
    }
    comparisonControls();
  }
  async function downloadComparisonMarkdown() {
    if (!app.comparison || !comparisonValid()) return;
    const { baseline, current } = comparisonPair(); const locale = i18n.locale(); const request = app.comparisonRequest;
    try {
      const result = await api(`/api/comparison?baseline=${encodeURIComponent(baseline)}&current=${encodeURIComponent(current)}`);
      if (request !== app.comparisonRequest || locale !== i18n.locale() || baseline !== $('compare-baseline').value || current !== $('compare-current').value || !app.comparison) return;
      app.comparisonMarkdown = result.markdown;
      download(`${baseline}-to-${current}.md`, result.markdown, 'text/markdown');
    } catch (error) { if (request === app.comparisonRequest && locale === i18n.locale()) comparisonStatus('comparison.error', { message: error instanceof Error ? error.message : String(error) }, true); }
  }
  function renderActive() {
    const active = app.state?.active;
    $('active-indicator').textContent = !app.connected ? t('app.disconnected') : active ? `${t(active.status === 'stopping' ? 'app.activeStopping' : active.kind === 'plan' ? 'app.activePlanning' : 'app.activeRunning')}${active.kind === 'run' ? ` · ${active.title}` : ''}` : t(app.planning ? 'app.requestingPlan' : 'top.waiting');
    $('connection-dot').classList.toggle('ready', app.connected);
    $('connection-label').textContent = t(app.connected ? 'app.connected' : 'app.disconnected');
    $('reconnect-btn').textContent = t(app.connected ? 'app.refreshSettings' : 'top.reconnect');
    const runtime = app.state?.runtime;
    $('runtime-status').textContent = !app.connected ? t('app.runtimeDisconnected') : runtime?.browserInstalled ? t('app.runtimeInstalled') : t('app.runtimeMissing', { command: runtime?.browserInstallCommand || 'npx playwright install chromium' });
    $('planner-readiness').textContent = t(!app.state?.models?.planner?.configured ? 'app.plannerUnconfigured' : !app.state.models.planner.keyReady ? 'app.plannerKeyMissing' : app.state.models.planner.kind !== 'openai-compatible' ? 'app.plannerCliOnly' : 'app.plannerReady');
    readiness();
  }
  async function refresh(full = false) {
    const previousActive = app.state?.active;
    let state;
    try { state = await api('/api/state'); } catch (error) { app.connected = false; renderActive(); throw error; }
    const initialize = !app.state;
    const libraryChanged = JSON.stringify(app.state?.suites) !== JSON.stringify(state.suites);
    const historyChanged = JSON.stringify(app.state?.runs) !== JSON.stringify(state.runs);
    app.state = state; app.connected = true;
    renderActive(); if (libraryChanged) renderLibrary(); if (historyChanged) { renderHistory(); renderComparisonOptions(); }
    if (full || initialize) { targetOptions(); modelForms(); }
    if (previousActive?.kind === 'run' && !state.active) { if (state.lastError) notice(state.lastError, true); else noticeKey('app.runEnded'); }
    if (state.lastError && state.lastError !== app.lastError) { app.lastError = state.lastError; notice(state.lastError, true); }
  }
  async function work(fn) { if (app.busy) return; app.busy = true; readiness(); notice(''); try { await fn(); } catch (error) { showError(error); } finally { app.busy = false; readiness(); } }
  async function loadSuite(file) { await work(async () => { const result = await api(`/api/suite?file=${encodeURIComponent(file)}`); if (!confirmScenarioReplacement('app.confirmReplaceDraft')) return; $('flow-input').value = result.flow || ''; setDraft(result.suite, result.script, 'library', result.flow || '', file, result.suiteHash || ''); noticeKey('app.suiteLoaded'); view('scenario'); }); }
  async function generate() { await work(async () => {
    const flow = $('flow-input').value.trim();
    if (!flow) throw localizedError('app.enterFlow');
    if (!app.state?.models?.planner?.configured || app.state.models.planner.kind !== 'openai-compatible' || !app.state.models.planner.keyReady) throw localizedError('app.configurePlanner');
    const request = ++app.planRequest; const platform = $('scenario-platform').value;
    app.planning = true; renderActive(); noticeKey('app.planStarted');
    try {
      const result = await api('/api/plan', { flow, platform });
      if (request !== app.planRequest) { noticeKey('app.planCancelledLate'); return; }
      setDraft(result.suite, result.script, 'generated', flow); noticeKey('app.planComplete');
    } catch (error) { if (request !== app.planRequest) noticeKey('app.planCancelledDraft'); else throw error; }
    finally { app.planning = false; await refresh(false).catch(() => {}); }
  }); }
  async function prompt() { await work(async () => { const flow = $('flow-input').value.trim(); if (!flow) throw localizedError('app.enterFlow'); const result = await api('/api/prompt', { flow, platform: $('scenario-platform').value }); download('flow-qa-prompt.md', result.prompt, 'text/markdown'); noticeKey('app.promptDownloaded'); }); }
  function editableFlow(flow) { return flow.replace(/\r\n?/g, '\n'); }
  function hasUnsavedScenario() {
    const flow = $('flow-input').value;
    const suite = $('suite-editor').value;
    if (!app.savedFile) return !!(flow.trim() || suite.trim());
    return flow !== editableFlow(app.sourceFlow)
      || suite !== JSON.stringify(app.draft, null, 2)
      || $('scenario-platform').value !== suitePlatform();
  }
  function confirmScenarioReplacement(key) {
    return !hasUnsavedScenario() || window.confirm(t(key));
  }
  function warnBeforeUnload(event) {
    if (!hasUnsavedScenario()) return;
    event.preventDefault();
    event.returnValue = '';
  }
  async function importFiles() {
    const files = [...$('import-json').files, ...$('import-markdown').files];
    let imported = false;
    await work(async () => {
      const jsonFiles = files.filter((file) => file.name.toLowerCase().endsWith('.json'));
      const markdownFiles = files.filter((file) => file.name.toLowerCase().endsWith('.md'));
      if (files.length > 2 || jsonFiles.length !== 1 || markdownFiles.length > 1 || jsonFiles.length + markdownFiles.length !== files.length) throw localizedError('app.importSelection');
      if (jsonFiles[0].size > 256 * 1024 || (markdownFiles[0] && markdownFiles[0].size > 128 * 1024)) throw localizedError('app.importTooLarge');
      let suite;
      try { suite = JSON.parse(await jsonFiles[0].text()); } catch { throw localizedError('app.invalidJson'); }
      const flow = markdownFiles[0] ? await markdownFiles[0].text() : undefined;
      const body = { suite, ...(flow === undefined ? {} : { flow }) };
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 256 * 1024) throw localizedError('app.importTooLarge');
      const result = await api('/api/import', body);
      if (!confirmScenarioReplacement('app.confirmReplaceDraft')) return;
      $('flow-input').value = flow || '';
      setDraft(result.suite, result.script, 'imported', flow || '');
      noticeKey('app.importComplete');
      imported = true;
    });
    if (imported) { $('import-json').value = ''; $('import-markdown').value = ''; }
  }
  async function compile() { await work(async () => {
    if (app.stale) throw localizedError('app.compileStale');
    let suite; try { suite = JSON.parse($('suite-editor').value); } catch { throw localizedError('app.invalidJson'); }
    if (suite && typeof suite === 'object' && !Array.isArray(suite)) {
      if (app.boundSource) suite.source = { ...app.boundSource };
      else delete suite.source;
    }
    const result = await api('/api/compile', { suite });
    const sourceFlow = app.sourceFlow || (!app.boundSource ? $('flow-input').value.trim() : '');
    setDraft(result.suite, result.script, app.origin === 'none' ? 'manual' : app.origin, sourceFlow, app.dirty ? '' : app.savedFile, app.dirty ? '' : app.savedHash);
    noticeKey('app.compileComplete');
  }); }
  async function save() { await work(async () => { if (!app.draft || app.dirty || app.stale) throw localizedError('app.needValidated'); const body = { suite: app.draft }; if (!app.boundSource && app.sourceFlow && (app.origin === 'imported' ? editableFlow(app.sourceFlow) === $('flow-input').value : app.sourceFlow === $('flow-input').value.trim())) body.flow = app.sourceFlow; const result = await api('/api/save', body); const saved = await api(`/api/suite?file=${encodeURIComponent(result.file)}`); $('flow-input').value = saved.flow || ''; setDraft(saved.suite, saved.script, 'library', saved.flow || '', result.file, saved.suiteHash || ''); noticeKey('app.savedSuite', { file: result.file }); await refresh(false); }); }
  async function run() { await work(async () => { if (!app.draft || !app.script || !app.savedFile || !app.savedHash || app.dirty || app.stale || !selectedCases().length || !$('review-checkbox').checked || !compatibleTarget()) throw localizedError('app.runNotReady'); const target = selectedTarget(); const body = { suite: app.savedFile, suiteHash: app.savedHash, targetName: target.name, targetFingerprint: target.targetFingerprint }; if (selectedCases().length < app.draft.cases.length) body.caseIds = selectedCases().map((item) => item.id); const result = await api('/api/run', body); noticeKey('app.runStarted', { id: result.operationId }); await refresh(false); }); }
  async function stop() {
    if (app.stopping || !app.state?.active) return;
    if (app.state.active.kind === 'plan' && app.planning) app.planRequest += 1;
    app.stopping = true; readiness();
    try { await api('/api/stop', {}); noticeKey('app.stopRequested'); await refresh(false); }
    catch (error) { showError(error); }
    finally { app.stopping = false; readiness(); }
  }
  async function loadReport(runId) { await work(async () => { const result = await api(`/api/report?runId=${encodeURIComponent(runId)}`); app.report = result.report; app.reportMarkdown = result.markdown; app.selectedRun = runId; renderReport(); readiness(); $('report-panel').hidden = false; $('report-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); }
  async function prepareFailedCases() { await work(async () => {
    const runId = app.selectedRun;
    const report = app.report;
    const navigationVersion = app.navigationVersion;
    if (!app.connected || app.state?.active || !runId || !report?.cases?.some((item) => item.status === 'failed' || item.status === 'error')) return;
    const result = await api(`/api/rerun?runId=${encodeURIComponent(runId)}`);
    if (app.selectedRun !== runId || app.report !== report || app.view !== 'history' || app.navigationVersion !== navigationVersion) return;
    await refresh(false);
    if (app.selectedRun !== runId || app.report !== report || app.view !== 'history' || app.navigationVersion !== navigationVersion || !app.connected || app.state?.active) return;
    if (!confirmScenarioReplacement('app.confirmReplaceDraft')) return;
    targetOptions();
    $('flow-input').value = result.flow || '';
    setDraft(result.suite, result.script, 'library', result.flow || '', result.file, result.suiteHash);
    app.selectedCaseIds = new Set(result.caseIds);
    renderCaseSelection();
    const target = app.displayTargets.find((item) => item.name === result.targetName);
    const sameTarget = result.targetMatches === true && target?.targetFingerprint === result.targetFingerprint;
    $('target-select').value = sameTarget ? target.name : '';
    app.rerunTargetMismatch = !sameTarget;
    app.rerunOrigin = { runId: result.originRunId, count: result.caseIds.length };
    renderRerunHints(); targetDescription();
    noticeKey(sameTarget ? 'app.rerunPrepared' : 'app.rerunPreparedTarget', app.rerunOrigin);
    view('scenario');
  }); }
  async function downloadReportMarkdown() {
    const runId = app.selectedRun; const locale = i18n.locale();
    if (!runId || !app.report) return;
    try {
      const result = await api(`/api/report?runId=${encodeURIComponent(runId)}`);
      if (runId !== app.selectedRun || locale !== i18n.locale()) return;
      app.reportMarkdown = result.markdown;
      download(`${runId}.md`, result.markdown, 'text/markdown');
    } catch (error) { if (runId === app.selectedRun && locale === i18n.locale()) showError(error); }
  }
  function renderReport() {
    const report = app.report; if (!report) return;
    $('report-heading').textContent = `${report.runId} · ${i18n.status(report.status)} · ${targetDisplay(report.target)}`;
    const host = $('report-content'); replace(host);
    const meta = el('div', 'report-meta'); for (const value of [t('app.reportStatus', { status: i18n.status(report.status) }), t('app.reportTarget', { target: targetDisplay(report.target) }), t('app.reportStarted', { date: formatDate(report.startedAt) }), t('app.reportFinished', { date: formatDate(report.finishedAt) })]) meta.append(el('span', '', value)); const scope = selectionScope(report.selection); if (scope) meta.append(el('span', 'selection-scope', scope)); host.append(meta);
    if (report.usage) host.append(el('p', 'hint', t('app.usage', { tokens: report.usage.modelTokens ?? t('app.unavailable'), cost: typeof report.usage.estimatedCostUsd === 'number' ? `$${report.usage.estimatedCostUsd.toFixed(4)}` : t('app.unavailable') })));
    if (report.errors?.length) host.append(el('p', 'report-errors', report.errors.join('\n')));
    for (const item of report.cases || []) {
      const section = el('section', 'case-report'); section.append(el('h3', '', `${item.id} · ${item.title} · ${i18n.status(item.status)}`));
      if (item.reason) section.append(el('p', '', t('app.reason', { reason: item.reason })));
      section.append(el('p', '', t('app.expected'))); const expected = el('ul', 'compact-list'); for (const check of item.expected || []) expected.append(el('li', '', check)); section.append(expected);
      for (const [attemptIndex, attempt] of (item.attempts || []).entries()) {
        section.append(el('p', '', t('app.attempt', { index: attempt.index + 1, status: i18n.status(attempt.status), duration: attempt.durationMs, error: attempt.error ? ` · ${attempt.error.code}: ${attempt.error.message}` : '' })));
        const steps = el('ul', 'compact-list'); for (const step of attempt.steps || []) steps.append(el('li', '', `${i18n.status(step.status)} · ${step.label}${step.error ? ` · ${step.error.code}: ${step.error.message}` : ''}`)); section.append(steps);
        for (const error of attempt.secondaryErrors || []) section.append(el('p', 'report-errors', t('app.secondaryError', { code: error.code, message: error.message })));
        const artifacts = el('div', 'evidence-list');
        for (const [artifactIndex, artifact] of (attempt.artifacts || []).entries()) {
          const row = el('div', 'evidence-item'); row.append(el('span', '', i18n.artifact(artifact.kind)));
          if (artifact.path && ['complete', 'not-required'].includes(artifact.redaction) && /\.(png|jpe?g|webp|txt|json|log)$/i.test(artifact.path)) {
            const query = new URLSearchParams({ runId: app.selectedRun, caseId: item.id, attempt: String(attemptIndex), artifact: String(artifactIndex) });
            const preview = el('a', 'text-button', t('app.viewEvidence')); preview.href = `/api/artifact?${query}`; preview.target = '_blank'; preview.rel = 'noopener noreferrer';
            const save = el('a', 'text-button', t('app.download')); save.href = `/api/artifact?${query}&download=1`; save.download = '';
            row.append(preview, save);
          } else row.append(el('span', 'hint', t('app.evidenceUnavailable')));
          artifacts.append(row);
        }
        section.append(artifacts);
      }
      host.append(section);
    }
  }
  async function saveModel(event) { event.preventDefault(); const form = event.currentTarget; await work(async () => { const values = new FormData(form); const body = { role: form.dataset.role, baseURL: String(values.get('baseURL') || '').trim(), model: String(values.get('model') || '').trim() }; const apiKeyEnv = String(values.get('apiKeyEnv') || '').trim(); if (apiKeyEnv) body.apiKeyEnv = apiKeyEnv; await api('/api/models', body); await refresh(true); noticeKey('app.modelSaved'); }); }
  async function clearModel(role) { await work(async () => { await api('/api/models', { role, clear: true }); await refresh(true); noticeKey('app.modelCleared'); }); }
  function targetFields() { const mobile = $('target-kind').value !== 'web'; for (const [id, required] of [['target-url-field', !mobile], ['target-bundle-field', mobile], ['target-device-field', mobile]]) { const field = $(id); field.hidden = !required; field.querySelector('input').required = required; } }
  async function saveTarget(event) { event.preventDefault(); const form = event.currentTarget; await work(async () => { const values = new FormData(form); const kind = String(values.get('kind') || 'web'); const body = { name: String(values.get('name') || '').trim(), description: String(values.get('description') || '').trim() }; if (kind === 'web') body.url = String(values.get('url') || '').trim(); else { body.kind = 'mobile'; body.platform = kind; body.bundleId = String(values.get('bundleId') || '').trim(); body.device = String(values.get('device') || '').trim(); } await api('/api/targets', body); form.reset(); targetFields(); await refresh(true); noticeKey('app.targetSaved'); }); }
  function renderLanguage() {
    const editedModels = [...document.querySelectorAll('.model-form')].map((form) => ({ role: form.dataset.role, values: Object.fromEntries([...form.querySelectorAll('input')].map((input) => [input.name, input.value])) }));
    const focusedModel = document.activeElement?.closest?.('.model-form');
    const focus = focusedModel ? { role: focusedModel.dataset.role, name: document.activeElement.name, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
    $('breadcrumb').textContent = t('app.breadcrumb', { name: t(names[app.view]) });
    const emptyTarget = $('target-select').querySelector('option[value=""]');
    if (emptyTarget) emptyTarget.textContent = t('scenario.selectTarget');
    for (const option of $('target-select').options) { const target = app.displayTargets.find((item) => item.name === option.value); if (target) option.textContent = targetDisplay(target); }
    const targetList = $('target-list'); for (const [row, target] of [...targetList.children].map((node, index) => [node, app.displayTargets[index]])) { if (target) row.replaceChildren(el('strong', '', target.name), document.createTextNode(` · ${targetLabel(target)}${target.description ? ` · ${target.description}` : ''}`)); }
    modelForms();
    for (const edited of editedModels) {
      const form = [...document.querySelectorAll('.model-form')].find((item) => item.dataset.role === edited.role);
      if (form) for (const [name, value] of Object.entries(edited.values)) { const input = form.elements.namedItem(name); if (input) input.value = value; }
    }
    if (focus) {
      const form = [...document.querySelectorAll('.model-form')].find((item) => item.dataset.role === focus.role);
      const input = form?.elements.namedItem(focus.name);
      if (input) { input.focus(); if (Number.isInteger(focus.start)) input.setSelectionRange(focus.start, focus.end); }
    }
    summarize(app.draft, true); renderCaseSelection();
    renderActive(); targetDescription(); renderRerunHints(); renderLibrary(); renderHistory(); renderComparisonOptions(); renderComparison(); renderReport();
    if (app.comparisonStatus) comparisonStatus(app.comparisonStatus, app.comparisonStatusParams || {}, app.comparisonStatus === 'comparison.error');
    app.reportMarkdown = '';
    if (app.notice) $('notice').textContent = t(app.notice.key, app.notice.params);
    else if (!$('notice').hidden) notice(''); // A server error has no stable code to translate; the next request uses the selected language.
  }
  function wire() {
    window.addEventListener('beforeunload', warnBeforeUnload);
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => view(button.dataset.view)));
    $('library-search').addEventListener('input', renderLibrary);
    $('history-search').addEventListener('input', renderHistory);
    $('history-status-filter').addEventListener('change', renderHistory);
    for (const id of ['compare-baseline', 'compare-current']) $(id).addEventListener('change', clearComparison);
    $('compare-btn').addEventListener('click', compareRuns);
    $('compare-swap').addEventListener('click', () => { const pair = comparisonPair(); $('compare-baseline').value = pair.current; $('compare-current').value = pair.baseline; clearComparison(); });
    $('comparison-filter').addEventListener('change', renderComparison);
    $('comparison-md').addEventListener('click', downloadComparisonMarkdown);
    $('comparison-json').addEventListener('click', () => { if (app.comparison && comparisonValid()) { const { baseline, current } = comparisonPair(); download(`${baseline}-to-${current}.json`, JSON.stringify(app.comparison, null, 2), 'application/json'); } });
    $('compare-open-baseline').addEventListener('click', () => { if (app.comparison && comparisonValid()) loadReport(app.comparison.baseline.runId); });
    $('compare-open-current').addEventListener('click', () => { if (app.comparison && comparisonValid()) loadReport(app.comparison.current.runId); });
    $('nav-toggle').addEventListener('click', () => { const open = $('sidebar').classList.toggle('nav-open'); $('nav-toggle').setAttribute('aria-expanded', String(open)); });
    $('library-shortcut').addEventListener('click', () => view('library'));
    $('new-draft-btn').addEventListener('click', () => {
      if (app.busy) return;
      const json = $('suite-editor').value;
      const unsavedJson = json.trim() && (!app.savedFile || json !== JSON.stringify(app.draft, null, 2));
      if (unsavedJson && !confirmScenarioReplacement('app.confirmNewDraft')) return;
      app.draft = null; app.selectedCaseIds = new Set(); app.script = ''; app.savedFile = ''; app.savedHash = '';
      app.origin = 'none'; app.sourceFlow = ''; app.boundSource = null; app.stale = false; app.dirty = false; app.rerunOrigin = null; app.rerunTargetMismatch = false; renderRerunHints();
      $('suite-editor').value = ''; $('review-checkbox').checked = false;
      summarize(null); renderCaseSelection(); readiness();
      noticeKey('app.newDraftNotice');
      $('suite-editor').focus();
    });
    $('flow-input').addEventListener('input', () => { if (app.origin === 'imported' ? $('flow-input').value !== editableFlow(app.sourceFlow) : (app.sourceFlow || app.boundSource) && $('flow-input').value.trim() !== editableFlow(app.sourceFlow).trim()) { app.stale = true; app.savedHash = ''; $('review-checkbox').checked = false; } readiness(); });
    $('scenario-platform').addEventListener('change', () => { app.planRequest += 1; if (app.draft) { app.stale = true; app.savedHash = ''; } $('review-checkbox').checked = false; readiness(); });
    $('suite-editor').addEventListener('input', () => { app.dirty = true; app.script = ''; app.savedFile = ''; app.savedHash = ''; if (app.origin === 'none') app.origin = 'manual'; $('review-checkbox').checked = false; summarize(null); readiness(); });
    $('review-checkbox').addEventListener('change', readiness); $('target-select').addEventListener('change', () => { $('review-checkbox').checked = false; if ($('target-select').value) { app.rerunTargetMismatch = false; renderRerunHints(); } targetDescription(); });
    $('case-selection-list').addEventListener('change', (event) => { const input = event.target.closest('input[data-case-id]'); if (!input) return; const next = new Set(app.selectedCaseIds); if (input.checked) next.add(input.dataset.caseId); else next.delete(input.dataset.caseId); changeCaseSelection(next); });
    $('select-all-cases').addEventListener('click', () => changeCaseSelection((app.draft?.cases || []).map((item) => item.id)));
    $('clear-case-selection').addEventListener('click', () => changeCaseSelection([]));
    $('plan-btn').addEventListener('click', generate); $('prompt-btn').addEventListener('click', prompt); $('compile-btn').addEventListener('click', compile); $('save-btn').addEventListener('click', save); $('run-btn').addEventListener('click', run); $('stop-btn').addEventListener('click', stop);
    $('import-btn').addEventListener('click', importFiles);
    $('global-stop-btn').addEventListener('click', stop);
    $('reconnect-btn').addEventListener('click', () => refresh(true).catch(showError));
    $('suite-download').addEventListener('click', () => { if (canDownloadSavedCases()) download(app.savedFile, `${JSON.stringify(app.draft, null, 2)}\n`, 'application/json'); });
    $('flow-download').addEventListener('click', () => { if (canDownloadSourceMarkdown()) download(app.draft.source.file.split('/').pop(), app.sourceFlow, 'text/markdown'); });
    $('script-download').addEventListener('click', () => { if (app.draft && !app.dirty && !app.stale) download(`${app.draft.id || 'flow-qa'}.test.mjs`, app.script, 'text/javascript'); });
    $('report-md').addEventListener('click', downloadReportMarkdown);
    $('report-json').addEventListener('click', () => { if (app.report) download(`${app.selectedRun}.json`, JSON.stringify(app.report, null, 2), 'application/json'); });
    $('report-rerun').addEventListener('click', prepareFailedCases);
    $('target-form').addEventListener('submit', saveTarget);
    $('target-kind').addEventListener('change', targetFields); targetFields();
    $('language-select').addEventListener('change', (event) => i18n.setLocale(event.currentTarget.value));
    i18n.onChange(() => { app.comparisonRequest += 1; if (app.comparisonBusy || app.comparisonStatus === 'comparison.error') comparisonStatus(app.comparison ? 'comparison.ready' : 'comparison.selectBoth'); app.comparisonBusy = false; renderLanguage(); comparisonControls(); });
    let refreshing = false;
    const poll = async () => { if (document.hidden || refreshing) return; refreshing = true; try { await refresh(false); } catch { /* Connection state offers explicit retry; avoid repeated alerts. */ } finally { refreshing = false; } };
    document.addEventListener('visibilitychange', poll);
    setInterval(poll, 2000);
  }
  i18n.applyStatic(); wire(); readiness(); refresh(true).catch(showError);
})();
