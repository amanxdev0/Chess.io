/* CHESS-IO — you vs Stockfish.
   Rules: chess.js · AI: Stockfish 10 (WASM, world-champion engine) with a
   local greedy fallback if the engine can't load. */
import { Chess } from 'chess.js';

/* ---------------- constants ---------------- */
const SF_JS = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';
const SF_WASM = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.wasm';

const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

const DIFFS = {
  easy:       { tag: 'EASY',       skill: 3,  depth: 6,  movetime: 0 },
  medium:     { tag: 'MEDIUM',     skill: 9,  depth: 10, movetime: 0 },
  hard:       { tag: 'HARD',       skill: 15, depth: 14, movetime: 0 },
  impossible: { tag: 'IMPOSSIBLE', skill: 20, depth: 22, movetime: 9000 },
};

/* ---------------- dom ---------------- */
const $ = (id) => document.getElementById(id);
const boardEl = $('board'), statusEl = $('status'), movesEl = $('moves');
const thinkingEl = $('thinking'), engineDot = document.querySelector('#engineStatus .dot');
const engineText = $('engineText'), diffTag = $('diffTag');
const topCaptured = $('topCaptured'), bottomCaptured = $('bottomCaptured');
const topClock = $('topClock'), bottomClock = $('bottomClock');
const materialLine = $('materialLine');

/* ---------------- tiny sound kit (WebAudio, no assets) ---------------- */
const Sound = {
  ctx: null,
  ensure() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* no audio */ }
  },
  tone(freq, dur, type, vol, delay) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + (delay || 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  },
  move() { this.tone(520, 0.07); },
  capture() { this.tone(300, 0.09, 'square', 0.09); this.tone(170, 0.12, 'square', 0.07, 0.03); },
  select() { this.tone(700, 0.04, 'sine', 0.05); },
  check() { this.tone(660, 0.09); this.tone(880, 0.12, 'sine', 0.1, 0.1); },
  end(win) {
    const seq = win ? [523, 659, 784, 1046] : [392, 330, 262, 196];
    seq.forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.12, i * 0.13));
  },
};

/* ---------------- Stockfish engine (blob worker + WASM) ---------------- */
const Engine = {
  worker: null, ready: false, waiters: [],
  setStatus(mode, text) {
    engineDot.className = 'dot ' + mode;
    engineText.textContent = text;
  },
  onLine(line) {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].test(line)) {
        this.waiters[i].resolve(line);
        this.waiters.splice(i, 1);
      }
    }
  },
  waitFor(test, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error('engine timeout'));
      }, timeoutMs);
      this.waiters.push({ test, resolve: (v) => { clearTimeout(t); resolve(v); } });
    });
  },
  async init() {
    try {
      const boot = 'var Module={};onmessage=function(e){' +
        'if(e.data&&e.data.wasmBinary){Module.wasmBinary=e.data.wasmBinary;' +
        'importScripts(' + JSON.stringify(SF_JS) + ');}};';
      this.worker = new Worker(URL.createObjectURL(new Blob([boot], { type: 'text/javascript' })));
      this.worker.onmessage = (e) => {
        String(e.data).split('\n').forEach((l) => { l = l.trim(); if (l) this.onLine(l); });
      };
      this.worker.onerror = () => { throw new Error('worker error'); };
      const wasm = await (await fetch(SF_WASM)).arrayBuffer();
      this.worker.postMessage({ wasmBinary: wasm }, [wasm]);
      this.worker.postMessage('uci');
      await this.waitFor((l) => l === 'uciok', 30000);
      this.worker.postMessage('isready');
      await this.waitFor((l) => l === 'readyok', 15000);
      this.ready = true;
      this.setStatus('ready', 'Stockfish 10 ready');
    } catch (e) {
      this.ready = false;
      this.worker = null;
      this.setStatus('failed', 'Engine offline — local AI');
    }
  },
  async findMove(fen, diffKey) {
    if (!this.ready || !this.worker) return null;
    const d = DIFFS[diffKey];
    try {
      this.worker.postMessage('position fen ' + fen);
      this.worker.postMessage('setoption name Skill Level value ' + d.skill);
      let go = 'go depth ' + d.depth;
      if (d.movetime) go += ' movetime ' + d.movetime;
      this.worker.postMessage(go);
      const line = await this.waitFor((l) => l.indexOf('bestmove ') === 0, 25000);
      const m = line.split(' ')[1];
      if (!m || m === '(none)') return null;
      return { from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] || undefined };
    } catch (e) {
      return null;
    }
  },
};

/* ---------------- greedy fallback AI (if engine fails) ---------------- */
function greedyMove(g) {
  const moves = g.moves({ verbose: true });
  if (!moves.length) return null;
  let best = moves[0], bestScore = -Infinity;
  for (const m of moves) {
    let s = Math.random() * 30;
    if (m.captured) s += (VAL[m.captured] || 0) * 10 - (VAL[m.piece] || 0);
    if (m.promotion) s += 800;
    if (m.san.includes('+')) s += 40;
    const f = m.to.charCodeAt(0) - 97, r = m.to.charCodeAt(1) - 49;
    s += (7 - Math.abs(3.5 - f) - Math.abs(3.5 - r)) * 6;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return { from: best.from, to: best.to, promotion: best.promotion };
}

/* ---------------- game state ---------------- */
let game = new Chess();
let playerColor = 'w';
let orientation = 'w';
let selected = null;
let legalCache = [];
let aiThinking = false;
let gameOver = false;
let gameId = 0;
let difficulty = 'impossible';
let hintSquares = [];
let clocks = { w: 600000, b: 600000 }; // ms; Infinity = no clock
let clockOn = false;

const aiColor = () => (playerColor === 'w' ? 'b' : 'w');

/* ---------------- rendering ---------------- */
function render() {
  boardEl.innerHTML = '';
  const b = game.board(); // rank 8 -> rank 1
  const hist = game.history({ verbose: true });
  const last = hist[hist.length - 1];
  const inCheck = game.isCheck();
  let kingSq = null;
  if (inCheck) {
    outer: for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = b[r][f];
      if (p && p.type === 'k' && p.color === game.turn()) { kingSq = p.square; break outer; }
    }
  }
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const rr = orientation === 'w' ? r : 7 - r;
      const ff = orientation === 'w' ? f : 7 - f;
      const cell = b[rr][ff];
      const file = 'abcdefgh'[ff];
      const rank = 8 - rr;
      const sqName = file + rank;
      const div = document.createElement('div');
      div.className = 'square ' + (((ff + rank) % 2 === 0) ? 'light' : 'dark');
      div.dataset.square = sqName;
      if (sqName === selected) div.classList.add('selected');
      if (last && (sqName === last.from || sqName === last.to)) div.classList.add('lastmove');
      if (sqName === kingSq) div.classList.add('check');
      if (hintSquares.includes(sqName)) div.classList.add('hintflash');
      // coordinates
      if (ff === (orientation === 'w' ? 0 : 7)) {
        const c = document.createElement('span');
        c.className = 'coord rank'; c.textContent = rank;
        div.appendChild(c);
      }
      if (rank === (orientation === 'w' ? 1 : 8)) {
        const c = document.createElement('span');
        c.className = 'coord file'; c.textContent = file;
        div.appendChild(c);
      }
      // legal move hints
      const lm = legalCache.find((m) => m.to === sqName);
      if (lm && selected) {
        const dot = document.createElement('span');
        dot.className = cell ? 'ring-hint' : 'dot-hint';
        div.appendChild(dot);
      }
      if (cell) {
        const sp = document.createElement('span');
        sp.className = 'piece ' + cell.color;
        sp.textContent = GLYPH[cell.type];
        div.appendChild(sp);
      }
      boardEl.appendChild(div);
    }
  }
  renderSide();
}

function renderSide() {
  const hist = game.history({ verbose: true });
  const takenByAI = [], takenByYou = [];
  hist.forEach((m) => {
    if (m.captured) (m.color === playerColor ? takenByYou : takenByAI).push(m.captured);
  });
  const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
  const show = (list, el, color) => {
    el.innerHTML = '';
    list.sort((a, b2) => order[a] - order[b2]).forEach((t) => {
      const s = document.createElement('span');
      s.className = color;
      s.textContent = GLYPH[t];
      el.appendChild(s);
    });
  };
  const aiC = aiColor();
  show(takenByAI, topCaptured, playerColor);   // AI captured your pieces
  show(takenByYou, bottomCaptured, aiC);       // you captured AI's pieces

  let diff = 0;
  takenByYou.forEach((t) => (diff += VAL[t]));
  takenByAI.forEach((t) => (diff -= VAL[t]));
  const units = Math.round(Math.abs(diff) / 100);
  materialLine.textContent = units === 0 ? '' :
    (diff > 0 ? `You are up +${units}` : `Stockfish is up +${units}`);

  // moves list
  movesEl.innerHTML = '';
  for (let i = 0; i < hist.length; i += 2) {
    const li = document.createElement('li');
    const s1 = document.createElement('span'); s1.className = 'mv'; s1.textContent = hist[i].san;
    li.appendChild(s1);
    if (hist[i + 1]) {
      const s2 = document.createElement('span'); s2.className = 'mv'; s2.textContent = hist[i + 1].san;
      li.appendChild(s2);
    }
    movesEl.appendChild(li);
  }
  movesEl.scrollTop = movesEl.scrollHeight;
  updateClocks();
}

function fmtClock(ms) {
  if (ms === Infinity) return '∞';
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function updateClocks() {
  const aiC = aiColor();
  topClock.textContent = fmtClock(clocks[aiC]);
  bottomClock.textContent = fmtClock(clocks[playerColor]);
  topClock.classList.toggle('low', clocks[aiC] !== Infinity && clocks[aiC] < 30000);
  bottomClock.classList.toggle('low', clocks[playerColor] !== Infinity && clocks[playerColor] < 30000);
  topClock.classList.toggle('active', !gameOver && game.turn() === aiC && clockOn);
  bottomClock.classList.toggle('active', !gameOver && game.turn() === playerColor && clockOn);
}

function setStatus(t) { statusEl.innerHTML = t; }

/* ---------------- move flow ---------------- */
function tryMove(from, to, promotion) {
  try {
    return game.move({ from, to, promotion });
  } catch (e) {
    return null;
  }
}

function afterMove(mv) {
  Sound.ensure();
  clockOn = true;
  if (mv.captured) Sound.capture(); else Sound.move();
  selected = null; legalCache = [];
  render();
  if (game.isCheck() && !isOver()) setTimeout(() => Sound.check(), 120);

  if (isOver()) { endGame(); return; }

  if (game.turn() !== playerColor) {
    setStatus('Stockfish is thinking…');
    aiTurn(gameId);
  } else {
    setStatus(game.isCheck() ? 'Check! Your move.' : 'Your move.');
  }
}

function isOver() {
  return game.isCheckmate() || game.isStalemate() || game.isDraw() ||
    game.isThreefoldRepetition() || game.isInsufficientMaterial();
}

async function aiTurn(id) {
  aiThinking = true;
  thinkingEl.hidden = false;
  render();
  const fen = game.fen();
  let uci = await Engine.findMove(fen, difficulty);
  if (id !== gameId) return; // new game started meanwhile
  let mv = null;
  if (uci) mv = tryMove(uci.from, uci.to, uci.promotion);
  if (!mv) {
    const g = greedyMove(game);
    if (g) mv = tryMove(g.from, g.to, g.promotion);
  }
  aiThinking = false;
  thinkingEl.hidden = true;
  if (id !== gameId) return;
  if (mv) afterMove(mv);
  else { setStatus('Your move.'); render(); }
}

/* ---------------- player input ---------------- */
boardEl.addEventListener('click', (e) => {
  const sqEl = e.target.closest('.square');
  if (!sqEl) return;
  onSquare(sqEl.dataset.square);
});

function onSquare(sq) {
  if (gameOver || aiThinking || game.turn() !== playerColor) return;
  Sound.ensure();
  if (selected) {
    const cand = legalCache.find((m) => m.to === sq);
    if (cand) {
      if (cand.promotion) { askPromotion(sq); return; }
      const mv = tryMove(selected, sq);
      if (mv) afterMove(mv);
      return;
    }
  }
  let piece = null;
  try { piece = game.get(sq); } catch (e) { /* ignore */ }
  if (piece && piece.color === playerColor) {
    if (selected === sq) { selected = null; legalCache = []; }
    else {
      selected = sq;
      legalCache = game.moves({ square: sq, verbose: true });
      Sound.select();
    }
  } else {
    selected = null; legalCache = [];
  }
  render();
}

/* ---------------- promotion ---------------- */
const promoModal = $('promoModal'), promoChoices = $('promoChoices');
function askPromotion(toSq) {
  promoChoices.innerHTML = '';
  ['q', 'r', 'b', 'n'].forEach((p) => {
    const b = document.createElement('button');
    b.innerHTML = `<span class="piece ${playerColor}" style="pointer-events:none">${GLYPH[p]}</span>`;
    b.setAttribute('aria-label', 'Promote to ' + p);
    b.addEventListener('click', () => {
      promoModal.hidden = true;
      const mv = tryMove(selected, toSq, p);
      if (mv) afterMove(mv);
    });
    promoChoices.appendChild(b);
  });
  promoModal.hidden = false;
}
promoModal.addEventListener('click', (e) => {
  if (e.target === promoModal) { promoModal.hidden = true; selected = null; legalCache = []; render(); }
});

/* ---------------- game over ---------------- */
const overModal = $('overModal');
function endGame(reason) {
  gameOver = true;
  clockOn = false;
  updateClocks();
  let emoji = '🤝', title = 'Draw', sub = '';
  const aiWon = reason === 'ai-checkmate' || reason === 'ai-flag' || reason === 'resign';
  const youWon = reason === 'you-checkmate' || reason === 'you-flag';

  if (game.isCheckmate()) {
    const winner = game.turn() === playerColor ? aiColor() : playerColor;
    if (winner === playerColor) { emoji = '🏆'; title = 'Checkmate!'; sub = 'You beat Stockfish. Legendary.'; }
    else { emoji = '♟️'; title = 'Checkmate'; sub = 'Stockfish wins. Demand a rematch.'; }
  } else if (game.isStalemate()) { sub = 'Stalemate — nobody wins.'; }
  else if (game.isThreefoldRepetition()) { sub = 'Draw by threefold repetition.'; }
  else if (game.isInsufficientMaterial()) { sub = 'Draw — insufficient material.'; }
  else if (game.isDraw()) { sub = 'Draw by the fifty-move rule.'; }
  else if (reason === 'you-flag') { emoji = '⏱️'; title = 'Time!'; sub = 'Stockfish flagged. You win on time!'; }
  else if (reason === 'ai-flag') { emoji = '⏱️'; title = 'Time!'; sub = 'You ran out of time.'; }
  else if (reason === 'resign') { emoji = '🏳️'; title = 'Resigned'; sub = 'Stockfish accepts your resignation.'; }

  $('overEmoji').textContent = emoji;
  $('overTitle').textContent = title;
  $('overSub').textContent = sub;
  overModal.hidden = false;
  Sound.ensure();
  Sound.end(youWon || (!aiWon && !youWon));
  setStatus(title + ' — ' + sub);
}
$('againBtn').addEventListener('click', () => { overModal.hidden = true; newGame(); });

/* ---------------- clocks ---------------- */
setInterval(() => {
  if (gameOver || !clockOn) return;
  if (game.history().length === 0) return;
  const t = game.turn();
  if (clocks[t] === Infinity) return;
  clocks[t] -= 250;
  if (clocks[t] <= 0) {
    clocks[t] = 0;
    updateClocks();
    endGame(t === playerColor ? 'ai-flag' : 'you-flag');
    return;
  }
  updateClocks();
}, 250);

/* ---------------- controls ---------------- */
function newGame() {
  gameId++;
  game = new Chess();
  playerColor = $('colorPick').value;
  orientation = playerColor;
  selected = null; legalCache = []; hintSquares = [];
  aiThinking = false; gameOver = false;
  thinkingEl.hidden = true;
  overModal.hidden = true;
  promoModal.hidden = true;
  const secs = parseInt($('timePick').value, 10);
  const ms = secs === 0 ? Infinity : secs * 1000;
  clocks = { w: ms, b: ms };
  clockOn = false;
  diffTag.textContent = DIFFS[difficulty].tag;
  $('topName').textContent = 'Stockfish';
  render();
  setStatus(playerColor === 'w' ? 'Your move — White to play.' : 'Stockfish opens as White…');
  if (playerColor === 'b') aiTurn(gameId);
}
$('newBtn').addEventListener('click', newGame);

$('difficulty').addEventListener('change', (e) => {
  difficulty = e.target.value;
  diffTag.textContent = DIFFS[difficulty].tag;
  if (!gameOver) setStatus('Difficulty: ' + DIFFS[difficulty].tag + '. ' +
    (game.turn() === playerColor ? 'Your move.' : 'Stockfish is thinking…'));
});

$('undoBtn').addEventListener('click', () => {
  if (aiThinking || game.history().length === 0) return;
  gameOver = false;
  overModal.hidden = true;
  game.undo(); // take back AI (or player) move
  if (game.history().length && game.turn() !== playerColor) game.undo(); // and player's
  selected = null; legalCache = [];
  render();
  setStatus('Move taken back. Your move.');
});

$('hintBtn').addEventListener('click', async () => {
  if (gameOver || aiThinking || game.turn() !== playerColor) return;
  setStatus('Analyzing… 💡');
  let uci = await Engine.findMove(game.fen(), 'medium');
  let target = null;
  if (uci) target = uci;
  else { const g = greedyMove(game); if (g) target = g; }
  if (target) {
    hintSquares = [target.from, target.to];
    render();
    setStatus('Hint: try <b>' + target.from + ' → ' + target.to + '</b>');
    setTimeout(() => { hintSquares = []; render(); }, 2600);
  } else setStatus('Your move.');
});

$('flipBtn').addEventListener('click', () => {
  orientation = orientation === 'w' ? 'b' : 'w';
  render();
});

$('resignBtn').addEventListener('click', () => {
  if (gameOver) return;
  gameId++;
  aiThinking = false;
  thinkingEl.hidden = true;
  endGame('resign');
});

/* ---------------- boot ---------------- */
diffTag.textContent = DIFFS[difficulty].tag;
render();
setStatus('Your move — White to play.');
Engine.init();
