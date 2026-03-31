/**
 * hangboard.js
 * Logika aplikacji Hangboard Timer.
 *
 * Odpowiedzialności:
 *  - sterowanie timerem (ćwiczenie / odpoczynek / serie)
 *  - sygnały dźwiękowe przez Web Audio API
 *  - autoryzacja Google OAuth 2.0 (implicit/token flow)
 *  - zapis historii sesji w localStorage
 *  - synchronizacja sesji z Google Sheets przez REST API
 */

// =============================================================================
// KONFIGURACJA
// =============================================================================

const CONFIG = {
  /** Client ID aplikacji OAuth zarejestrowanej w Google Cloud Console. */
  GOOGLE_CLIENT_ID: '273762301841-au9ct7mbb43m67p2oqp60lheuhkjsrn9.apps.googleusercontent.com',

  /** Nazwa arkusza (zakładki) wewnątrz pliku Google Sheets. */
  SHEET_NAME: 'Hangboard',
};

// =============================================================================
// STAN GLOBALNY TIMERA
// =============================================================================

let timerInterval = null;   // Uchwyt do setInterval — potrzebny do clearInterval()
let currentPhase  = null;   // Aktualna faza: 'exercise' | 'rest' | null
let currentTime   = 0;      // Pozostały czas bieżącej fazy (sekundy)
let phaseDuration = 0;      // Pełny czas bieżącej fazy — potrzebny do przeliczenia paska postępu
let currentRep    = 0;      // Numer aktualnie wykonywanej serii (1-based)
let totalReps     = 0;      // Łączna liczba serii zaplanowanych w sesji
let isRunning     = false;  // Czy timer aktualnie odlicza (nie jest spauzowany)
let isPaused      = false;  // Czy timer jest spauzowany w połowie sesji
let sessionStart  = null;   // Date zapamiętana przy starcie — do obliczenia czasu trwania sesji

// =============================================================================
// STAN GLOBALNY — AUDIO I GOOGLE
// =============================================================================

/**
 * Kontekst Web Audio API.
 * Inicjowany dopiero po interakcji użytkownika (wymóg przeglądarek mobilnych).
 * @type {AudioContext|null}
 */
let audioCtx = null;

/**
 * Aktywny access token Google OAuth.
 * Null gdy użytkownik nie jest zalogowany lub token wygasł.
 * @type {string|null}
 */
let accessToken = null;

/**
 * ID arkusza Google Sheets przypisanego do tego użytkownika.
 * Persystowane w localStorage, żeby nie tworzyć nowego pliku przy każdym zalogowaniu.
 * @type {string|null}
 */
let userSpreadsheetId = localStorage.getItem('hb_spreadsheet_id');

/**
 * Historia sesji przechowywana lokalnie (max 50 wpisów).
 * Każdy wpis to obiekt: { date, time, reps, weight, exTime, reTime, duration }.
 * @type {Array<Object>}
 */
let sessionLog = JSON.parse(localStorage.getItem('hb_log') || '[]');

// =============================================================================
// SKRÓT — getElementById
// =============================================================================

/** Skrót do document.getElementById, analogicznie do jQuery $. */
const $ = id => document.getElementById(id);

// =============================================================================
// AUDIO — WEB AUDIO API
// =============================================================================

/**
 * Inicjuje AudioContext i od razu odtwarza cichy bufor.
 *
 * Musi być wywołane bezpośrednio w obsłudze zdarzenia użytkownika (np. klik),
 * bo przeglądarki mobilne (szczególnie iOS Safari) blokują autoplay audio
 * do momentu pierwszej interakcji. Cichy bufor "odblokowuje" kontekst.
 */
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // Niektóre przeglądarki zawieszają kontekst po utracie focusu — wznawiamy.
  if (audioCtx.state === 'suspended') audioCtx.resume();

  // Odtwarzamy 1-sampowy cichy bufor, żeby odblokować audio na iOS.
  const silentBuffer = audioCtx.createBuffer(1, 1, 22050);
  const source = audioCtx.createBufferSource();
  source.buffer = silentBuffer;
  source.connect(audioCtx.destination);
  source.start(0);
}

/**
 * Odtwarza krótki sygnał dźwiękowy (beep) przez oscylator.
 *
 * @param {number} [freq=880]     - Częstotliwość tonu w Hz.
 * @param {number} [duration=0.2] - Czas trwania dźwięku w sekundach.
 * @param {number} [volume=0.3]   - Głośność (0.0–1.0).
 */
function beep(freq = 880, duration = 0.2, volume = 0.3) {
  if (!audioCtx) return; // Audio niezainicjowane — pomijamy

  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.frequency.value = freq;

  // Ustawiamy głośność i wygaszamy do zera (exponential fade — brzmi naturalniej).
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

// =============================================================================
// GOOGLE AUTH — OAuth 2.0 Token Flow
// =============================================================================

/**
 * Zapisuje access token i czas jego wygaśnięcia w localStorage.
 * Dzięki temu przy kolejnym otwarciu aplikacji nie trzeba logować się ponownie.
 *
 * @param {string} token      - Access token zwrócony przez Google.
 * @param {number} expires_in - Czas ważności tokena w sekundach.
 */
function saveToken(token, expires_in) {
  localStorage.setItem('google_token', token);
  localStorage.setItem('google_token_expiry', new Date().getTime() + (expires_in * 1000));
  accessToken = token;
}

/**
 * Sprawdza, czy w localStorage jest ważny token Google i loguje użytkownika automatycznie.
 * Wywołuje Google userinfo API, żeby potwierdzić że token nadal działa.
 *
 * @returns {Promise<boolean>} True jeśli auto-login się udał.
 */
async function checkAutoLogin() {
  const savedToken = localStorage.getItem('google_token');
  const expiry     = localStorage.getItem('google_token_expiry');

  const tokenStillValid = savedToken && expiry && new Date().getTime() < expiry;
  if (!tokenStillValid) return false;

  accessToken = savedToken;

  try {
    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    }).then(r => r.json());

    if (info.email) {
      $('googleBtnText').textContent = info.name || info.email;
      $('syncStatus').textContent    = '● połączono automatycznie';
      $('syncStatus').className      = 'ok';
      return true;
    }
  } catch (e) {
    // Token mógł wygasnąć wcześniej niż deklarował — ignorujemy i wymagamy ponownego logowania.
    console.warn('Auto-login: token nieważny lub wygasł.', e);
  }

  return false;
}

/**
 * Obsługuje kliknięcie przycisku Google:
 *  - jeśli użytkownik jest zalogowany → wylogowuje (czyści localStorage i przeładowuje stronę)
 *  - jeśli nie jest zalogowany → otwiera okno wyboru konta Google
 *
 * Po udanym logowaniu:
 *  - pobiera dane profilu (imię / email) i aktualizuje przycisk
 *  - tworzy arkusz Google Sheets jeśli nie istnieje, lub weryfikuje nagłówki kolumn
 */
function handleGoogleAuth() {
  // Wylogowanie — czyścimy token i restartujemy stronę do stanu niezalogowanego.
  if (accessToken) {
    localStorage.removeItem('google_token');
    localStorage.removeItem('google_token_expiry');
    location.reload();
    return;
  }

  // Inicjujemy klienta OAuth z wymaganymi zakresami uprawnień:
  //   - spreadsheets: odczyt i zapis danych w arkuszach
  //   - drive.file:   tworzenie nowych plików na Dysku użytkownika
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ].join(' '),

    callback: async (resp) => {
      if (resp.error) return; // Użytkownik anulował lub wystąpił błąd

      saveToken(resp.access_token, resp.expires_in);

      // Pobieramy dane profilu, żeby wyświetlić imię użytkownika na przycisku.
      const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + accessToken },
      }).then(r => r.json());

      $('googleBtnText').textContent = info.name || info.email;

      if (!userSpreadsheetId) {
        // Pierwsze logowanie — tworzymy nowy arkusz.
        await createSheetForUser();
      } else {
        // Kolejne logowanie — weryfikujemy tylko, czy nagłówki kolumn są na miejscu.
        $('syncStatus').textContent = '● połączono';
        $('syncStatus').className   = 'ok';
        await ensureSheetHeaders();
      }
    },
  });

  client.requestAccessToken();
}

// =============================================================================
// USTAWIENIA — kontrolki +/−
// =============================================================================

/**
 * Zmienia wartość inputa o podaną deltę (+1 lub -1).
 * Dla pól liczbowych: minimalna wartość to 1.
 * Dla pola "weight" (obciążenie): minimalna wartość to 0 (można ćwiczyć bez obciążenia).
 *
 * @param {'exercise'|'rest'|'reps'|'weight'} field - Nazwa pola do zmiany.
 * @param {number} delta - Wartość zmiany (+1 lub -1).
 */
function adj(field, delta) {
  const fieldToInputId = {
    exercise : 'exerciseTime',
    rest     : 'restTime',
    reps     : 'repsCount',
    weight   : 'weightValue',
  };

  const el = $(fieldToInputId[field]);

  if (field === 'weight') {
    el.value = Math.max(0, parseFloat(el.value) + delta);
  } else {
    el.value = Math.max(1, parseInt(el.value) + delta);
  }
}

// =============================================================================
// TIMER — sterowanie
// =============================================================================

/**
 * Obsługuje przycisk Start / Pauza / Wznów (jeden przycisk, trzy stany).
 *
 * Stany:
 *  - zatrzymany (isRunning=false, isPaused=false) → startuje nową sesję
 *  - działający  (isRunning=true)                 → pauzuje
 *  - spauzowany  (isPaused=true)                  → wznawia od miejsca pauzy
 */
function toggleStart() {
  // Inicjujemy audio przy pierwszej interakcji użytkownika (wymóg iOS).
  initAudio();

  if (!isRunning && !isPaused) {
    // --- START nowej sesji ---
    totalReps    = parseInt($('repsCount').value);
    currentRep   = 0;
    isRunning    = true;
    sessionStart = new Date();

    $('startBtn').textContent  = 'Pauza';
    $('doneMsg').style.display = 'none';

    startExercise();

  } else if (isRunning) {
    // --- PAUZA ---
    clearInterval(timerInterval);
    isRunning = false;
    isPaused  = true;

    $('startBtn').textContent = 'Wznów';

  } else {
    // --- WZNOWIENIE po pauzie ---
    isRunning = true;
    isPaused  = false;

    $('startBtn').textContent = 'Pauza';
    timerInterval = setInterval(timerTick, 1000);
  }
}

/**
 * Rozpoczyna fazę ćwiczenia.
 * Inkrementuje licznik serii — jeśli przekroczono planowaną liczbę, kończy sesję.
 */
function startExercise() {
  currentRep++;

  if (currentRep > totalReps) {
    finishSession();
    return;
  }

  currentPhase  = 'exercise';
  phaseDuration = parseInt($('exerciseTime').value);
  currentTime   = phaseDuration;

  setPhase('exercise', 'ćwiczenie');

  // Wysoki dźwięk (C6 ≈ 1046 Hz) sygnalizuje start ćwiczenia.
  beep(1046, 0.3);

  timerInterval = setInterval(timerTick, 1000);
}

/**
 * Rozpoczyna fazę odpoczynku po ćwiczeniu.
 * Jeśli to była ostatnia seria, kończy sesję bez czekania na odpoczynek.
 */
function startRest() {
  if (currentRep >= totalReps) {
    finishSession();
    return;
  }

  currentPhase  = 'rest';
  phaseDuration = parseInt($('restTime').value);
  currentTime   = phaseDuration;

  setPhase('rest', 'odpoczynek');

  timerInterval = setInterval(timerTick, 1000);
}

/**
 * Wywoływana co sekundę przez setInterval.
 * Dekrementuje czas, aktualizuje UI i obsługuje przejście między fazami.
 */
function timerTick() {
  currentTime--;
  updateDisplay();

  if (currentTime <= 0) {
    // Faza się skończyła — przechodzimy do następnej.
    clearInterval(timerInterval);

    if (currentPhase === 'exercise') {
      // Niski dźwięk (A4 = 440 Hz) sygnalizuje koniec ćwiczenia / start odpoczynku.
      beep(440, 0.3);
      startRest();
    } else {
      startExercise();
    }
  } else if (currentPhase === 'rest' && currentTime <= 3) {
    // 3-sekundowe odliczanie końca odpoczynku — subtelny dźwięk ostrzegawczy.
    beep(660, 0.1, 0.2);
  }
}

/**
 * Kończy sesję: zapisuje wynik lokalnie, aktualizuje UI
 * i (jeśli zalogowany) synchronizuje dane z Google Sheets.
 */
function finishSession() {
  const now             = new Date();
  const durationSeconds = Math.round((now - sessionStart) / 1000);
  const weight          = parseFloat($('weightValue').value);

  const session = {
    date    : now.toLocaleDateString('pl-PL'),
    time    : now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
    reps    : totalReps,
    weight,
    exTime  : parseInt($('exerciseTime').value),
    reTime  : parseInt($('restTime').value),
    duration: durationSeconds,
  };

  // Dodajemy na początek listy i ograniczamy historię do 50 wpisów.
  sessionLog.unshift(session);
  localStorage.setItem('hb_log', JSON.stringify(sessionLog.slice(0, 50)));
  renderLog();

  // Aktualizujemy timer do stanu "ukończono".
  $('timerDisplay').textContent = 'GRATULACJE!!! 🥳';
  $('timerDisplay').className   = 'done';
  $('doneMsg').textContent      = `Sesja zakończona: ${totalReps} powtórzeń z obciążeniem ${weight}kg.`;
  $('doneMsg').style.display    = 'block';

  clearInterval(timerInterval);
  isRunning = false;
  isPaused  = false;
  $('startBtn').textContent = 'Start';

  // Synchronizacja z Sheets — tylko jeśli użytkownik jest zalogowany i arkusz istnieje.
  if (accessToken && userSpreadsheetId) {
    appendToSheets(session);
  }
}

/**
 * Resetuje timer do stanu początkowego bez zapisywania sesji.
 */
function resetTimer() {
  clearInterval(timerInterval);
  isRunning = false;
  isPaused  = false;

  $('startBtn').textContent     = 'Start';
  $('timerDisplay').textContent = '—';
  $('progressBar').style.width  = '0%';
  $('doneMsg').style.display    = 'none';
}

// =============================================================================
// TIMER — aktualizacja UI
// =============================================================================

/**
 * Ustawia nazwę i klasę CSS bieżącej fazy oraz odświeża wyświetlacz.
 * Klasa CSS (exercise/rest) zmienia kolory timera i paska postępu.
 *
 * @param {'exercise'|'rest'} cls - Klasa CSS fazy.
 * @param {string}            lbl - Etykieta tekstowa wyświetlana nad timerem.
 */
function setPhase(cls, lbl) {
  $('phaseLabel').textContent = lbl;
  $('phaseLabel').className   = cls;
  $('repDisplay').textContent = `${currentRep}/${totalReps}`;
  updateDisplay();
}

/**
 * Odświeża licznik czasu, klasę CSS timera oraz pasek postępu.
 * Wywoływana po każdym tyknięciu timera i przy zmianie fazy.
 */
function updateDisplay() {
  $('timerDisplay').textContent = currentTime;
  $('timerDisplay').className   = currentPhase;
  $('progressBar').className    = currentPhase;

  // Pasek postępu rośnie od 0% do 100% w trakcie trwania fazy.
  const progress = ((phaseDuration - currentTime) / phaseDuration) * 100;
  $('progressBar').style.width = progress + '%';
}

/**
 * Renderuje historię sesji jako listę HTML.
 * Odczytuje dane z modułu-poziomu tablicy sessionLog (zsynchronizowanej z localStorage).
 */
function renderLog() {
  $('logList').innerHTML = sessionLog.map(s =>
    `<li class="log-item">
      <span class="log-dt">${s.date} ${s.time}</span>
      <span style="font-weight:600">${s.weight}kg</span>
      <span>${s.reps} powt.</span>
    </li>`
  ).join('');
}

/**
 * Wyświetla tymczasowe powiadomienie (toast) na dole ekranu.
 *
 * @param {string} message - Treść powiadomienia.
 */
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// =============================================================================
// GOOGLE SHEETS — REST API
// =============================================================================

/**
 * Tworzy nowy plik Google Sheets o nazwie "Mój Trening Hangboard" na Dysku użytkownika.
 * Wywoływana tylko przy pierwszym logowaniu (gdy userSpreadsheetId nie istnieje w localStorage).
 * Po utworzeniu wywołuje ensureSheetHeaders(), żeby dodać nagłówki kolumn.
 */
async function createSheetForUser() {
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method : 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type' : 'application/json',
    },
    body: JSON.stringify({
      properties: { title: 'Mój Trening Hangboard' },
      sheets    : [{ properties: { title: CONFIG.SHEET_NAME } }],
    }),
  });

  const data = await response.json();
  userSpreadsheetId = data.spreadsheetId;
  localStorage.setItem('hb_spreadsheet_id', userSpreadsheetId);

  await ensureSheetHeaders();

  $('syncStatus').textContent = '● arkusz gotowy';
  $('syncStatus').className   = 'ok';
}

/**
 * Sprawdza, czy wiersz nagłówkowy (A1:G1) istnieje w arkuszu.
 * Jeśli nie — wstawia nagłówki kolumn metodą PUT (nadpisanie zakresu).
 * Zapobiega duplikowaniu nagłówków przy ponownym logowaniu.
 */
async function ensureSheetHeaders() {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${userSpreadsheetId}/values/${CONFIG.SHEET_NAME}!A1:G1`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  const data = await response.json();

  if (!data.values) {
    // Arkusz jest pusty — wstawiamy nagłówki.
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${userSpreadsheetId}/values/${CONFIG.SHEET_NAME}!A1?valueInputOption=USER_ENTERED`,
      {
        method : 'PUT',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type' : 'application/json',
        },
        body: JSON.stringify({
          values: [['Data', 'Godzina', 'Waga', 'Reps', 'Ex', 'Rest', 'Total']],
        }),
      }
    );
  }
}

/**
 * Dopisuje jeden wiersz z wynikami sesji na koniec arkusza (metoda append).
 * Wywoływana automatycznie po zakończeniu każdej sesji, gdy użytkownik jest zalogowany.
 *
 * @param {Object} session           - Dane zakończonej sesji.
 * @param {string} session.date      - Data w formacie lokalnym.
 * @param {string} session.time      - Godzina w formacie HH:MM.
 * @param {number} session.weight    - Obciążenie w kg.
 * @param {number} session.reps      - Liczba serii.
 * @param {number} session.exTime    - Czas ćwiczenia w sekundach.
 * @param {number} session.reTime    - Czas odpoczynku w sekundach.
 * @param {number} session.duration  - Całkowity czas sesji w sekundach.
 */
async function appendToSheets(session) {
  try {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${userSpreadsheetId}/values/${CONFIG.SHEET_NAME}!A:G:append?valueInputOption=USER_ENTERED`,
      {
        method : 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type' : 'application/json',
        },
        body: JSON.stringify({
          values: [[
            session.date,
            session.time,
            session.weight,
            session.reps,
            session.exTime,
            session.reTime,
            session.duration,
          ]],
        }),
      }
    );
    toast('Zapisano w Google Sheets!');
  } catch (e) {
    console.error('Błąd synchronizacji z Google Sheets:', e);
  }
}

// =============================================================================
// INICJALIZACJA
// =============================================================================

window.onload = () => {
  renderLog();      // Wypełniamy listę historii danymi z localStorage
  checkAutoLogin(); // Próbujemy zalogować automatycznie jeśli token jest ważny
};
