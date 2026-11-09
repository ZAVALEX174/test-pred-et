'use strict';

// Страховка от повторов: отсеиваем совпадения по номеру и по тексту.
function dedupe(list) {
  const seenId = new Set(), seenText = new Set(), out = [];
  for (const q of list) {
    const key = (q.stem + '|' + q.options.join('|')).toLowerCase().replace(/[^а-яё0-9]/g, '');
    if (seenId.has(q.id) || seenText.has(key)) continue;
    seenId.add(q.id); seenText.add(key); out.push(q);
  }
  return out;
}

const POOL_EXAM = dedupe(QUESTIONS);                                   // канонические 80
const POOL_FULL = dedupe(QUESTIONS.concat(QUESTIONS_EXTRA));           // полный банк
const BY_ID = new Map(POOL_FULL.map(q => [q.id, q]));

const BANKS = {
  exam: { name: 'Экзаменационный', pool: POOL_EXAM },
  full: { name: 'Полный банк',     pool: POOL_FULL }
};

const PASS_PERCENT = 70;          // минимальный порог
let bank = 'exam';
let POOL = POOL_EXAM;
let TOTAL = POOL.length;          // вопросов в выбранном банке = 100%
let PASS_COUNT = Math.ceil(TOTAL * PASS_PERCENT / 100);

function applyBank(b) {
  bank = BANKS[b] ? b : 'exam';
  POOL = BANKS[bank].pool;
  TOTAL = POOL.length;
  PASS_COUNT = Math.ceil(TOTAL * PASS_PERCENT / 100);
}

const TIME_LIMIT_MS = 60 * 60 * 1000;   // 60 минут для уровней 2 и 4

const LEVELS = {
  1: { name: 'Обычный',          timed: false, shuffleOptions: false },
  2: { name: 'На время',         timed: true,  shuffleOptions: false },
  3: { name: 'С перемешиванием', timed: false, shuffleOptions: true  },
  4: { name: 'Экзамен',          timed: true,  shuffleOptions: true  }
};

const STORE_KEY = 'accred-quiz-v3';
const LEVEL_KEY = 'accred-quiz-level';
const BANK_KEY = 'accred-quiz-bank';
const DISCLAIMER_KEY = 'accred-quiz-disclaimer-accepted';

const el = (id) => document.getElementById(id);
const startBox = el('start'), quizBox = el('quiz'), finalBox = el('final');
const optionsBox = el('options'), feedbackBox = el('feedback');
const answerBtn = el('answer'), nextBtn = el('next'), restartBtn = el('restart');
const saveNote = el('saveNote'), timerBox = el('timer'), levelBadge = el('levelBadge');
const pdfLink = el('pdfLink');

const PDF_FILE = 'Notes_260722_102832.pdf';

let level = 1;
let order = [];      // перемешанный список вопросов
let views = [];      // порядок вывода вариантов для каждого вопроса: [исходный номер, ...]
let index = 0;       // текущая позиция
let current = null;  // текущий вопрос
let currentView = [];
let picked = new Set();   // выбранные ПОКАЗАННЫЕ номера
let locked = false;       // на текущий вопрос уже отвечено
let correctCount = 0, wrongCount = 0;
let log = [];        // [{id, chosen:[показанные], view:[...], ok:bool, skipped:bool}]
let done = false;
let deadline = 0;    // момент окончания времени (мс epoch), 0 — без таймера
let timedOut = false;
let tickId = null;

/* ---------- сохранение прогресса ---------- */

let storageOk = true;

const LS = (() => {
  try {
    const s = window.localStorage;
    s.setItem('__probe', '1');
    s.removeItem('__probe');
    return s;
  } catch (e) {
    storageOk = false;
    return null;
  }
})();

function save() {
  if (!LS || !order.length) return;
  try {
    LS.setItem(STORE_KEY, JSON.stringify({
      v: 3,
      bank: bank,
      level: level,
      orderIds: order.map(q => q.id),
      views: views,
      index: index,
      graded: locked,
      done: done,
      timedOut: timedOut,
      deadline: deadline,
      correctCount: correctCount,
      wrongCount: wrongCount,
      log: log,
      ts: Date.now()
    }));
  } catch (e) {
    storageOk = false;
    showSaveNote();
  }
}

function clearSave() {
  if (!LS) return;
  try { LS.removeItem(STORE_KEY); } catch (e) { /* игнорируем */ }
}

function loadSave() {
  if (!LS) return null;
  try {
    const raw = LS.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.v !== 3) return null;
    if (!BANKS[s.bank] || !LEVELS[s.level]) return null;
    const n = BANKS[s.bank].pool.length;
    if (!Array.isArray(s.orderIds) || s.orderIds.length !== n) return null;
    if (s.orderIds.some(id => !BY_ID.has(id))) return null;      // база вопросов изменилась
    if (!Array.isArray(s.views) || s.views.length !== n) return null;
    for (let i = 0; i < n; i++) {
      const q = BY_ID.get(s.orderIds[i]);
      const v = s.views[i];
      if (!Array.isArray(v) || v.length !== q.options.length) return null;
      if (new Set(v).size !== v.length) return null;
      if (v.some(n => n < 1 || n > q.options.length)) return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

function showSaveNote(text) {
  if (!saveNote) return;
  if (!storageOk) {
    saveNote.textContent = 'Браузер запретил локальное сохранение — прогресс не восстановится после перезагрузки.';
    saveNote.className = 'save-note warn';
    saveNote.hidden = false;
    return;
  }
  if (text) {
    saveNote.textContent = text;
    saveNote.className = 'save-note';
    saveNote.hidden = false;
  } else {
    saveNote.hidden = true;
  }
}

function stamp() {
  const answered = correctCount + wrongCount;
  if (done) return 'Результат сохранён на этом устройстве — страницу можно закрывать.';
  return 'Прогресс сохраняется автоматически: отвечено ' + answered + ' из ' + TOTAL +
         '. Обрыв связи или перезагрузка ничего не потеряют' +
         (LEVELS[level].timed ? ', таймер продолжит идти с сохранённого момента.' : '.');
}

function when(ts) {
  try { return new Date(ts).toLocaleString('ru-RU'); } catch (e) { return ''; }
}

/* ---------- таймер ---------- */

function fmt(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(t / 60), s = t % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function stopTimer() {
  if (tickId) { clearInterval(tickId); tickId = null; }
}

function startTimer() {
  stopTimer();
  if (!LEVELS[level].timed || done) { timerBox.hidden = true; return; }
  timerBox.hidden = false;
  tick();
  tickId = setInterval(tick, 1000);
}

function tick() {
  const left = deadline - Date.now();
  timerBox.textContent = 'Осталось ' + fmt(left);
  timerBox.classList.toggle('warn', left <= 5 * 60 * 1000);
  timerBox.classList.toggle('over', left <= 0);
  if (left <= 0) { stopTimer(); timeUp(); }
}

// Время вышло: все вопросы, до которых не дошли, засчитываются как неотвеченные.
function timeUp() {
  if (done) return;
  timedOut = true;
  const from = locked ? index + 1 : index;
  for (let i = from; i < TOTAL; i++) {
    const q = order[i];
    log.push({ id: q.id, chosen: [], view: views[i], ok: false, skipped: true });
    wrongCount++;
    addRow(q, false, [], views[i], true);
  }
  index = TOTAL - 1;
  finish(false);
}

/* ---------- ход теста ---------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function identity(n) {
  const a = [];
  for (let i = 1; i <= n; i++) a.push(i);
  return a;
}

function letters(nums) { return nums.map(String).join(', '); }

// Показанные номера правильных ответов с учётом перемешивания вариантов.
function correctDisplay(q, view) {
  const out = [];
  view.forEach((orig, i) => { if (q.correct.includes(orig)) out.push(i + 1); });
  return out.sort((a, b) => a - b);
}

function resetTable() {
  el('resultsBody').innerHTML = '<tr class="empty"><td colspan="4">Здесь появятся ваши ответы.</td></tr>';
  el('tableMeta').textContent = 'Ответов пока нет';
}

function selectedBank() {
  const r = document.querySelector('input[name="bank"]:checked');
  return r && BANKS[r.value] ? r.value : 'exam';
}

function setBankRadio(v) {
  const r = document.querySelector('input[name="bank"][value="' + v + '"]');
  if (r) r.checked = true;
}

function selectedLevel() {
  const r = document.querySelector('input[name="level"]:checked');
  const v = r ? Number(r.value) : 1;
  return LEVELS[v] ? v : 1;
}

function setLevelRadio(v) {
  const r = document.querySelector('input[name="level"][value="' + v + '"]');
  if (r) r.checked = true;
}

function goHome() {
  stopTimer();
  clearSave();
  order = []; views = []; log = [];
  index = 0; correctCount = 0; wrongCount = 0;
  done = false; timedOut = false; deadline = 0; locked = false;
  resetTable();
  startBox.hidden = false;
  quizBox.hidden = true;
  finalBox.hidden = true;
  restartBtn.hidden = true;
  timerBox.hidden = true;
  showSaveNote();
  setLevelRadio(level);
  setBankRadio(bank);
  startBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function start() {
  clearSave();
  applyBank(selectedBank());
  level = selectedLevel();
  try {
    if (LS) { LS.setItem(LEVEL_KEY, String(level)); LS.setItem(BANK_KEY, bank); }
  } catch (e) { /* игнорируем */ }

  // Перестановка всего пула: каждый вопрос выпадает ровно один раз за прохождение.
  order = shuffle(POOL);
  // Порядок вывода вариантов: перемешивается только расположение, сами тексты не меняются.
  views = order.map(q => LEVELS[level].shuffleOptions
    ? shuffle(identity(q.options.length))
    : identity(q.options.length));

  index = 0; correctCount = 0; wrongCount = 0; log = [];
  done = false; timedOut = false;
  deadline = LEVELS[level].timed ? Date.now() + TIME_LIMIT_MS : 0;

  resetTable();
  startBox.hidden = true;
  finalBox.hidden = true;
  quizBox.hidden = false;
  restartBtn.hidden = false;
  render();
  startTimer();
  save();
  showSaveNote(stamp());
}

function render() {
  current = order[index];
  currentView = views[index];
  picked = new Set();
  locked = false;

  el('counter').textContent = 'Вопрос ' + (index + 1) + ' из ' + TOTAL;
  el('progressFill').style.width = (index / TOTAL * 100) + '%';
  levelBadge.textContent = BANKS[bank].name + ' (' + TOTAL + ') · уровень ' + level + ' — ' + LEVELS[level].name;
  updateLiveScore();

  el('qnum').textContent = '№ ' + current.id;
  el('multiTag').hidden = !current.multi;
  const srcTag = el('srcTag');
  if (current.src && current.src.length) {
    srcTag.textContent = 'Источник: ' + current.src.join(', ');
    srcTag.hidden = false;
  } else {
    srcTag.hidden = true;
  }

  if (current.page) {
    pdfLink.href = PDF_FILE + '#page=' + current.page;
    pdfLink.textContent = 'PDF, стр. ' + current.page + ' ↗';
    pdfLink.title = 'Открыть исходный PDF на странице с этим вопросом';
    pdfLink.hidden = false;
  } else {
    pdfLink.hidden = true;
  }

  el('stem').textContent = current.stem;
  el('evaluate').hidden = !current.evaluate;

  optionsBox.innerHTML = '';
  currentView.forEach((orig, i) => {
    const n = i + 1;                       // номер, который видит пользователь
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.dataset.n = String(n);
    b.innerHTML = '<span class="idx">' + n + '</span><span class="txt"></span>';
    b.querySelector('.txt').textContent = current.options[orig - 1];
    b.addEventListener('click', () => onPick(n, b));
    optionsBox.appendChild(b);
  });

  feedbackBox.hidden = true;
  feedbackBox.className = 'feedback';
  nextBtn.hidden = true;
  answerBtn.hidden = !current.multi;
  answerBtn.disabled = true;
}

function onPick(n, btn) {
  if (locked || done) return;
  if (current.multi) {
    if (picked.has(n)) { picked.delete(n); btn.classList.remove('picked'); }
    else { picked.add(n); btn.classList.add('picked'); }
    answerBtn.disabled = picked.size === 0;
  } else {
    picked = new Set([n]);
    grade(false);
  }
}

// replay = true — восстановление уже отвеченного вопроса после перезагрузки:
// счётчики и строка таблицы не трогаются, рисуется только подсветка.
function grade(replay) {
  locked = true;
  answerBtn.hidden = true;

  const rightD = correctDisplay(current, currentView);
  const rightSet = new Set(rightD);
  const chosen = [...picked].sort((a, b) => a - b);
  const isRight = chosen.length === rightSet.size && chosen.every(n => rightSet.has(n));

  optionsBox.querySelectorAll('.opt').forEach(b => {
    const n = Number(b.dataset.n);
    b.classList.add('locked');
    b.classList.remove('picked');
    const flag = document.createElement('span');
    flag.className = 'flag';
    if (picked.has(n) && rightSet.has(n)) { b.classList.add('correct'); flag.textContent = 'верно'; }
    else if (picked.has(n) && !rightSet.has(n)) { b.classList.add('wrong'); flag.textContent = 'неверно'; }
    else if (!picked.has(n) && rightSet.has(n)) { b.classList.add('missed'); flag.textContent = 'правильный ответ'; }
    if (flag.textContent) b.appendChild(flag);
  });

  feedbackBox.className = 'feedback ' + (isRight ? 'ok' : 'bad');
  let html = isRight
    ? '<b>Верно.</b>'
    : '<b>Неверно.</b> Правильный ответ: ' + letters(rightD) + ' — ' +
      rightD.map(d => current.options[currentView[d - 1] - 1]).join('; ');
  if (current.note) html += '<span class="note">' + current.note + '</span>';
  feedbackBox.innerHTML = html;
  feedbackBox.hidden = false;

  if (!replay) {
    if (isRight) correctCount++; else wrongCount++;
    log.push({ id: current.id, chosen: chosen, view: currentView, ok: isRight });
    addRow(current, isRight, chosen, currentView, false);
    updateLiveScore();
    save();
    showSaveNote(stamp());
  }

  nextBtn.hidden = false;
  nextBtn.textContent = (index + 1 >= TOTAL) ? 'Показать итог' : 'Следующий вопрос';
  if (!replay) nextBtn.focus();
}

function addRow(q, isRight, chosen, view, skipped) {
  const body = el('resultsBody');
  const empty = body.querySelector('tr.empty');
  if (empty) empty.remove();

  const tr = document.createElement('tr');
  tr.className = isRight ? 'row-ok' : 'row-bad';

  const tdNum = document.createElement('td');
  tdNum.textContent = q.id;

  const tdQ = document.createElement('td');
  tdQ.textContent = q.stem;

  const tdA = document.createElement('td');
  tdA.className = 'answer';
  if (chosen.length) {
    tdA.textContent = chosen.map(d => d + '. ' + q.options[view[d - 1] - 1]).join(' | ');
  } else if (skipped) {
    tdA.innerHTML = '<span class="dash">не отвечен — время вышло</span>';
  } else {
    tdA.innerHTML = '<span class="dash">—</span>';
  }

  const tdR = document.createElement('td');
  if (isRight) {
    tdR.innerHTML = '<span class="dash">—</span>';
  } else {
    tdR.className = 'answer';
    tdR.textContent = correctDisplay(q, view).map(d => d + '. ' + q.options[view[d - 1] - 1]).join(' | ');
  }

  tr.append(tdNum, tdQ, tdA, tdR);
  body.appendChild(tr);

  const answered = correctCount + wrongCount;
  el('tableMeta').textContent =
    'Отвечено ' + answered + ' из ' + TOTAL + ' · верных ' + correctCount + ' · неверных ' + wrongCount;
}

function rebuildTable() {
  resetTable();
  if (!log.length) return;
  el('resultsBody').innerHTML = '';
  for (const rec of log) {
    const q = BY_ID.get(rec.id);
    if (q) addRow(q, rec.ok, rec.chosen, rec.view, !!rec.skipped);
  }
}

function updateLiveScore() {
  const pct = Math.round(correctCount / TOTAL * 100);
  el('scoreLive').textContent = 'Верно: ' + correctCount + ' · Неверно: ' + wrongCount + ' · ' + pct + '%';
}

function next() {
  index++;
  if (index >= TOTAL) { finish(false); return; }
  render();
  save();
  quizBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function finish(replay) {
  done = true;
  stopTimer();
  timerBox.hidden = true;
  startBox.hidden = true;
  quizBox.hidden = true;
  finalBox.hidden = false;
  restartBtn.hidden = false;
  el('progressFill').style.width = '100%';

  const pct = Math.round(correctCount / TOTAL * 100);
  const passed = pct >= PASS_PERCENT;

  const verdict = el('verdict');
  verdict.className = passed ? 'pass' : 'fail';
  verdict.textContent = passed
    ? 'Тест сдан — ' + pct + '% (порог ' + PASS_PERCENT + '%)'
    : 'Тест не сдан — ' + pct + '%. Нужно минимум ' + PASS_PERCENT + '% (' + PASS_COUNT +
      ' верных ответов из ' + TOTAL + ')';

  const skipped = log.filter(r => r.skipped).length;
  const fNote = el('finalNote');
  let noteText = 'Уровень ' + level + ' — ' + LEVELS[level].name + '.';
  if (timedOut) {
    noteText += ' Время вышло: ' + skipped + ' ' + plural(skipped, 'вопрос', 'вопроса', 'вопросов') +
                ' остались без ответа и засчитаны как ошибки.';
  }
  fNote.textContent = noteText;
  fNote.hidden = false;

  el('fCorrect').textContent = correctCount;
  el('fWrong').textContent = wrongCount;
  el('fPercent').textContent = pct + '%';

  save();
  if (!replay) {
    showSaveNote(stamp());
    finalBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ---------- восстановление после перезагрузки ---------- */

function restore(s) {
  applyBank(s.bank);
  setBankRadio(bank);
  level = s.level;
  order = s.orderIds.map(id => BY_ID.get(id));
  views = s.views;
  index = Math.min(Math.max(s.index | 0, 0), TOTAL - 1);
  correctCount = s.correctCount | 0;
  wrongCount = s.wrongCount | 0;
  log = Array.isArray(s.log) ? s.log : [];
  done = !!s.done;
  timedOut = !!s.timedOut;
  deadline = s.deadline || 0;
  setLevelRadio(level);

  rebuildTable();
  restartBtn.hidden = false;
  startBox.hidden = true;

  if (done) {
    finish(true);
    showSaveNote('Восстановлен завершённый тест (уровень ' + level + ' — ' + LEVELS[level].name +
                 ') от ' + when(s.ts) + '. Нажмите «Начать заново» для новой попытки.');
    return;
  }

  quizBox.hidden = false;
  render();

  // Вопрос был отвечен, но страница перезагрузилась до перехода дальше — вернём подсветку.
  if (s.graded && log.length) {
    const last = log[log.length - 1];
    if (last.id === current.id) {
      picked = new Set(last.chosen);
      picked.forEach(n => {
        const b = optionsBox.querySelector('.opt[data-n="' + n + '"]');
        if (b) b.classList.add('picked');
      });
      grade(true);
    }
  }

  if (LEVELS[level].timed && deadline - Date.now() <= 0) {
    // Время истекло, пока страница была закрыта.
    timerBox.hidden = false;
    timerBox.textContent = 'Время вышло';
    timerBox.classList.add('over');
    timeUp();
    showSaveNote('Пока страница была закрыта, отведённые 60 минут истекли — тест закрыт автоматически.');
    return;
  }

  startTimer();
  showSaveNote('Прогресс восстановлен: уровень ' + level + ' — ' + LEVELS[level].name +
               ', вопрос ' + (index + 1) + ' из ' + TOTAL + ', сохранено ' + when(s.ts) + '.');
}

function fillBankCounts() {
  const ex = el('bankExamCount'), fu = el('bankFullCount');
  if (ex) ex.textContent = POOL_EXAM.length;
  if (fu) fu.textContent = POOL_FULL.length;
  const exP = el('bankExamPass'), fuP = el('bankFullPass');
  if (exP) exP.textContent = Math.ceil(POOL_EXAM.length * PASS_PERCENT / 100);
  if (fuP) fuP.textContent = Math.ceil(POOL_FULL.length * PASS_PERCENT / 100);
}

/* ---------- поиск ответа по слову из вопроса ---------- */

const EXAM_IDS = new Set(POOL_EXAM.map(q => q.id));
const SEARCH_PAGE = 20;          // сколько результатов показывать за раз
let searchHits = [], searchWords = [], searchShown = 0;

// Нижний регистр + «ё» → «е». Длина строки не меняется, поэтому позиции совпадений
// в нормализованном тексте совпадают с позициями в исходном (нужно для подсветки).
function norm(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Подсветка всех найденных слов через <mark>.
function highlight(text, words) {
  text = String(text);
  const n = norm(text);
  if (n.length !== text.length || !words.length) return escapeHtml(text);
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    let from = 0, i;
    while ((i = n.indexOf(w, from)) !== -1) {
      for (let k = i; k < i + w.length; k++) marks[k] = true;
      from = i + w.length;
    }
  }
  let out = '', open = false;
  for (let k = 0; k < text.length; k++) {
    if (marks[k] && !open) { out += '<mark>'; open = true; }
    if (!marks[k] && open) { out += '</mark>'; open = false; }
    out += escapeHtml(text[k]);
  }
  if (open) out += '</mark>';
  return out;
}

function runSearch() {
  const input = el('searchInput');
  const raw = input.value.trim();
  const inOptions = el('searchInOptions').checked;
  el('searchClear').hidden = raw === '';

  searchWords = norm(raw).split(/\s+/).filter(w => w.length >= 2);
  searchHits = [];
  searchShown = 0;
  el('searchResults').innerHTML = '';

  if (!searchWords.length) {
    el('searchMeta').textContent = raw
      ? 'Введите хотя бы 2 буквы.'
      : 'Поиск идёт по всем вопросам полного банка. Регистр и буква «ё» не важны; несколько слов — найдутся вопросы, где есть все.';
    el('searchMore').hidden = true;
    return;
  }

  for (const q of POOL_FULL) {
    const hay = norm(inOptions ? q.stem + ' ' + q.options.join(' ') : q.stem);
    if (searchWords.every(w => hay.includes(w))) searchHits.push(q);
  }

  el('searchMeta').textContent = searchHits.length
    ? 'Найдено: ' + searchHits.length + ' ' + plural(searchHits.length, 'вопрос', 'вопроса', 'вопросов') + '.'
    : 'Ничего не найдено' + (inOptions ? '.' : '. Попробуйте отметить «искать также в вариантах ответов» или сократить слово до корня.');
  showMoreResults();
}

function showMoreResults() {
  const box = el('searchResults');
  const slice = searchHits.slice(searchShown, searchShown + SEARCH_PAGE);
  for (const q of slice) box.appendChild(searchCard(q));
  searchShown += slice.length;
  const more = el('searchMore');
  more.hidden = searchShown >= searchHits.length;
  more.textContent = 'Показать ещё (' + (searchHits.length - searchShown) + ')';
}

function searchCard(q) {
  const div = document.createElement('div');
  div.className = 'sr-item';
  let html = '<div class="sr-head"><span class="qnum">№ ' + q.id + '</span>' +
    '<span class="tag">' + (EXAM_IDS.has(q.id) ? 'экзаменационный' : 'дополнительный') + '</span>';
  if (q.multi) html += '<span class="tag multi">Несколько правильных ответов</span>';
  if (q.page) html += '<a class="tag pdf" href="' + PDF_FILE + '#page=' + q.page +
    '" target="_blank" rel="noopener">PDF, стр. ' + q.page + ' ↗</a>';
  html += '</div><p class="sr-stem">' + highlight(q.stem, searchWords) + '</p><ul class="sr-opts">';
  q.options.forEach((opt, i) => {
    const right = q.correct.includes(i + 1);
    html += '<li class="' + (right ? 'right' : '') + '"><span class="idx">' + (i + 1) + '</span><span>' +
      highlight(opt, searchWords) + (right ? ' ✓' : '') + '</span></li>';
  });
  html += '</ul>';
  if (q.note) html += '<p class="sr-note">' + q.note + '</p>';
  div.innerHTML = html;
  return div;
}

let searchTimer = null;
el('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});
el('searchInOptions').addEventListener('change', runSearch);
el('searchClear').addEventListener('click', () => {
  el('searchInput').value = '';
  runSearch();
  el('searchInput').focus();
});
el('searchMore').addEventListener('click', showMoreResults);

/* ---------- события ---------- */

el('begin').addEventListener('click', start);
el('again').addEventListener('click', goHome);
restartBtn.addEventListener('click', () => {
  const answered = correctCount + wrongCount;
  if (answered > 0 && !done &&
      !confirm('Начать заново? Сохранённый прогресс этой попытки будет удалён.')) return;
  goHome();
});
answerBtn.addEventListener('click', () => { if (picked.size) grade(false); });
nextBtn.addEventListener('click', next);
window.addEventListener('pagehide', save);
window.addEventListener('beforeunload', save);

/* ---------- дисклеймер ---------- */

// Показывается при открытии и закрывается только кнопкой «Согласен».
// Ни клик по фону, ни Esc его не закрывают. Согласие запоминается в этом браузере;
// если localStorage недоступен — окно показывается при каждом открытии.
function initDisclaimer() {
  const overlay = el('disclaimer');
  const accept = el('acceptDisclaimer');
  if (!overlay || !accept) return;

  let accepted = false;
  try { accepted = LS && LS.getItem(DISCLAIMER_KEY) === '1'; } catch (e) { accepted = false; }

  if (accepted) { overlay.hidden = true; return; }

  overlay.hidden = false;
  document.body.classList.add('disclaimer-open');
  accept.addEventListener('click', () => {
    try { if (LS) LS.setItem(DISCLAIMER_KEY, '1'); } catch (e) { /* игнорируем */ }
    overlay.hidden = true;
    document.body.classList.remove('disclaimer-open');
  });
  accept.focus();
}

(function boot() {
  initDisclaimer();
  if (!LS) { showSaveNote(); return; }
  try {
    const savedL = Number(LS.getItem(LEVEL_KEY));
    if (LEVELS[savedL]) { level = savedL; setLevelRadio(savedL); }
    const savedB = LS.getItem(BANK_KEY);
    if (BANKS[savedB]) { applyBank(savedB); setBankRadio(savedB); }
  } catch (e) { /* игнорируем */ }
  fillBankCounts();
  const s = loadSave();
  if (s) restore(s);
})();
