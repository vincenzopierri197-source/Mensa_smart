import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, runTransaction, onSnapshot } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB69-Y42-OqXnbqaJkJWBERJlaklbTPEQo",
  authDomain: "mensa-smart.firebaseapp.com",
  projectId: "mensa-smart",
  storageBucket: "mensa-smart.firebasestorage.app",
  messagingSenderId: "1083527699670",
  appId: "1:1083527699670:web:719eae0f384e3a4c837d77"
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

(function () {
  const STORAGE_KEY = "gestione_mensa_pro_v1";
  const MONTH_NAMES = [
    "", "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
    "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"
  ];
  const DAY_NAMES = [
    "Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"
  ];

  function createDefaultMonths() {
    const list = [];
    list.push({ id: "2026-11", year: 2026, month: 11 });
    list.push({ id: "2026-12", year: 2026, month: 12 });
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      list.push({ id: "2027-" + mm, year: 2027, month: m });
    }
    return list;
  }

  function createDefaultState() {
    return {
      mealPrice: 3.10,
      voucherPrice: 3.10,
      months: createDefaultMonths(),
      records: {},
      payments: {},
      notes: []
    };
  }

  function isValidState(value) {
    return Boolean(value && Array.isArray(value.months) && value.months.length > 0 &&
      value.records && typeof value.records === "object" &&
      value.payments && typeof value.payments === "object");
  }

  function stateFromStorage(storageKey = STORAGE_KEY) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return isValidState(parsed) ? parsed : null;
    } catch (e) {
      console.warn("Impossibile leggere lo stato salvato:", e);
      return null;
    }
  }

  function loadState(storageKey = STORAGE_KEY) {
    return stateFromStorage(storageKey) || createDefaultState();
  }

  let state = loadState();
  let activeTab = "summary";
  let calendarMode = "month";
  let calendarCursor = new Date();
  let currentUser = null;
  let pendingProfileUser = null;
  let anonymousSignInPending = false;
  let remoteSaveTimer = null;
  let authLoadToken = 0;
  let sharedRecoveryCode = null;
  let lastSharedState = null;
  let unsubscribeSharedArchive = null;

  const RECOVERY_CODE_KEY = "mensa_smart_recovery_code_v1";
  const BACKUP_FORMAT = "mensa-smart-encrypted-backup";
  const BACKUP_ITERATIONS = 310000;
  const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function getOrCreateRecoveryCode(uid) {
    const key = RECOVERY_CODE_KEY + ":" + uid;
    let code = localStorage.getItem(key);
    if (!code || !/^[A-HJ-NP-Z2-9]{16}$/.test(code)) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      code = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
      localStorage.setItem(key, code);
    }
    return code;
  }

  // Il codice personale identifica un documento di recupero cloud.
  // Nel database viene salvato solo l'hash del codice come ID, non il codice in chiaro.
  async function recoveryCodeHash(code) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function cloneState(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // Applica le modifiche locali alla versione remota senza perdere
  // modifiche indipendenti già arrivate dall'altro dispositivo.
  function mergeConcurrentState(base, local, remote) {
    if (sameValue(local, base)) return cloneState(remote);
    if (sameValue(remote, base)) return cloneState(local);

    const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (isObject(base) && isObject(local) && isObject(remote)) {
      const result = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
      for (const key of keys) {
        const b = base[key], l = local[key], r = remote[key];
        if (!(key in local) && key in base) continue;
        if (!(key in remote) && key in base && sameValue(l, b)) continue;
        const merged = mergeConcurrentState(b, l, r);
        if (merged !== undefined) result[key] = merged;
      }
      return result;
    }

    // Gli elenchi di mesi vengono uniti per ID: due dispositivi possono
    // aggiungere mesi diversi senza cancellarsi reciprocamente.
    if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote) &&
        [...base, ...local, ...remote].every(item => item && typeof item === "object" && item.id)) {
      const bm = new Map(base.map(item => [item.id, item]));
      const lm = new Map(local.map(item => [item.id, item]));
      const rm = new Map(remote.map(item => [item.id, item]));
      const ids = new Set([...bm.keys(), ...lm.keys(), ...rm.keys()]);
      const merged = [];
      for (const id of ids) {
        if (!lm.has(id) && bm.has(id)) continue;
        if (!rm.has(id) && bm.has(id) && sameValue(lm.get(id), bm.get(id))) continue;
        const item = mergeConcurrentState(bm.get(id), lm.get(id), rm.get(id));
        if (item !== undefined) merged.push(item);
      }
      return merged;
    }

    // In caso di modifica simultanea dello stesso singolo campo prevale
    // l'ultima transazione completata; i campi diversi vengono invece uniti.
    return local === undefined ? undefined : cloneState(local);
  }

  async function getRecoveryDocumentRef(code) {
    const hash = await recoveryCodeHash(code);
    return doc(db, "recoveryCodes", hash);
  }

  async function findRecoverySnapshot(code) {
    const recoveryRef = await getRecoveryDocumentRef(code);
    const recoverySnapshot = await getDoc(recoveryRef);
    if (!recoverySnapshot.exists()) return null;
    const recovered = recoverySnapshot.data();
    return isValidState(recovered.appState) ? recovered.appState : null;
  }

  function stopSharedArchiveListener() {
    if (unsubscribeSharedArchive) unsubscribeSharedArchive();
    unsubscribeSharedArchive = null;
  }

  async function listenToSharedArchive(code, user) {
    stopSharedArchiveListener();
    const recoveryRef = await getRecoveryDocumentRef(code);
    unsubscribeSharedArchive = onSnapshot(recoveryRef, (snapshot) => {
      if (!snapshot.exists() || !currentUser || currentUser.uid !== user.uid) return;
      const remoteState = snapshot.data().appState;
      if (!isValidState(remoteState)) return;

      const base = lastSharedState || remoteState;
      const merged = mergeConcurrentState(base, state, remoteState);
      lastSharedState = cloneState(remoteState);

      if (!sameValue(merged, state)) {
        state = merged;
        try {
          localStorage.setItem(STORAGE_KEY + ":" + user.uid, JSON.stringify(state));
        } catch (e) {
          console.warn("Impossibile aggiornare la copia locale:", e);
        }
        render();
      }
      if (!sameValue(merged, remoteState)) saveState();
      else setSyncStatus("Sincronizzato in tempo reale");
    }, (error) => {
      console.error("Errore ascolto archivio condiviso:", error);
      setSyncStatus("Errore aggiornamento in tempo reale");
    });
  }

  function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function deriveBackupKey(code, salt) {
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: BACKUP_ITERATIONS, hash: "SHA-256" },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  async function createEncryptedBackup(snapshot, code) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(code, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      format: BACKUP_FORMAT,
      version: 1,
      kdf: "PBKDF2-SHA-256",
      iterations: BACKUP_ITERATIONS,
      cipher: "AES-256-GCM",
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      createdAt: new Date().toISOString()
    };
  }

  async function readBackupFile(file, code) {
    const parsed = JSON.parse(await file.text());
    if (parsed && parsed.format === BACKUP_FORMAT && parsed.version === 1) {
      if (!code || !/^[A-HJ-NP-Z2-9]{16}$/.test(code)) {
        throw new Error("Inserisci il codice personale di 16 caratteri.");
      }
      const key = await deriveBackupKey(code, base64ToBytes(parsed.salt));
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(parsed.iv) },
        key,
        base64ToBytes(parsed.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(decrypted));
    }
    // Compatibilità: accetta anche i vecchi backup Mensa Smart non cifrati.
    return parsed;
  }

  function setSyncStatus(message) {
    const status = document.getElementById("syncStatus");
    if (status) status.textContent = message;
  }

  function saveState() {
    const localKey = currentUser ? STORAGE_KEY + ":" + currentUser.uid : STORAGE_KEY;
    try {
      localStorage.setItem(localKey, JSON.stringify(state));
    } catch (e) {
      console.warn("Impossibile salvare nel localStorage:", e);
    }
    if (!currentUser || !sharedRecoveryCode) return;

    const user = currentUser;
    const localSnapshot = cloneState(state);
    setSyncStatus("Salvataggio…");
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(async () => {
      try {
        const recoveryRef = await getRecoveryDocumentRef(sharedRecoveryCode);
        let committedState = null;
        await runTransaction(db, async (transaction) => {
          const remoteSnapshot = await transaction.get(recoveryRef);
          const remoteState = remoteSnapshot.exists() && isValidState(remoteSnapshot.data().appState)
            ? remoteSnapshot.data().appState : (lastSharedState || localSnapshot);
          const base = lastSharedState || remoteState;
          committedState = mergeConcurrentState(base, localSnapshot, remoteState);
          transaction.set(recoveryRef, {
            ownerUid: user.uid,
            appState: committedState,
            updatedAt: Date.now()
          }, { merge: true });
        });
        if (currentUser && currentUser.uid === user.uid) {
          // Conserva eventuali altre modifiche fatte mentre la transazione era in corso.
          const editsMadeDuringSave = cloneState(state);
          const finalState = mergeConcurrentState(localSnapshot, editsMadeDuringSave, committedState);
          state = finalState;
          lastSharedState = cloneState(committedState);
          localStorage.setItem(STORAGE_KEY + ":" + user.uid, JSON.stringify(state));
          if (!sameValue(finalState, committedState)) {
            setSyncStatus("Sincronizzo altre modifiche…");
            saveState();
          } else {
            setSyncStatus("Salvato e sincronizzato su Firebase");
          }
          render();
        }
      } catch (error) {
        console.error("Errore durante il salvataggio su Firebase:", error);
        if (currentUser && currentUser.uid === user.uid) setSyncStatus("Errore di sincronizzazione");
      }
    }, 350);
  }

  function setAuthMessage(message, isError = false) {
    const element = document.getElementById("authMessage");
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("error", isError);
  }

  function authErrorMessage(error) {
    const messages = {
      "auth/operation-not-allowed": "L’accesso anonimo non è ancora attivo. In Firebase vai su Authentication → Metodo di accesso → Anonimo e attivalo.",
      "auth/configuration-not-found": "Firebase Authentication non è configurato per questo progetto.",
      "auth/invalid-api-key": "La chiave API Firebase non è valida. Controlla la configurazione Web.",
      "auth/network-request-failed": "Connessione a Firebase non riuscita. Controlla internet e riprova.",
      "auth/too-many-requests": "Troppi tentativi. Attendi qualche minuto e riprova.",
      "permission-denied": "Le regole Firestore non consentono l’accesso ai dati dell’account."
    };
    const friendly = messages[error.code];
    if (friendly) return friendly;
    const code = error.code || "errore-sconosciuto";
    const details = error.message ? String(error.message).replace(/^Firebase:\\s*/i, "").slice(0, 180) : "";
    return "Errore Firebase (" + code + "). " + (details || "Controlla la connessione e riprova.");
  }

  function showProfileSetup(user, token) {
    if (token !== authLoadToken) return;
    pendingProfileUser = user;
    currentUser = null;
    document.getElementById("appShell").hidden = true;
    document.getElementById("authGate").hidden = false;
    document.getElementById("profileActions").hidden = false;
    document.getElementById("authRetry").hidden = true;
    setAuthMessage("È il tuo primo accesso su questo dispositivo. Crea un profilo oppure ripristina il tuo backup con codice e file JSON.");
  }

  async function finishProfileSetup(user, restoredState, recoveryCode = null) {
    const code = recoveryCode || getOrCreateRecoveryCode(user.uid);
    const recoveryRef = await getRecoveryDocumentRef(code);
    let initialState = restoredState;

    // Se l'archivio esiste già, non lo sovrascriviamo con la copia
    // appena caricata: il documento remoto è sempre la fonte autorevole.
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(recoveryRef);
      if (existing.exists() && isValidState(existing.data().appState)) {
        initialState = existing.data().appState;
      } else {
        transaction.set(recoveryRef, {
          ownerUid: user.uid,
          appState: initialState,
          updatedAt: Date.now()
        }, { merge: true });
      }
    });

    state = initialState;
    currentUser = user;
    sharedRecoveryCode = code;
    lastSharedState = cloneState(state);
    pendingProfileUser = null;
    localStorage.setItem(STORAGE_KEY + ":" + user.uid, JSON.stringify(state));
    localStorage.setItem(RECOVERY_CODE_KEY + ":" + user.uid, code);
    document.getElementById("accountIdentity").textContent = "Archivio condiviso";
    document.getElementById("accountCode").textContent = "Codice personale: " + code;
    document.getElementById("authGate").hidden = true;
    document.getElementById("profileActions").hidden = true;
    document.getElementById("appShell").hidden = false;
    await listenToSharedArchive(code, user);
    setSyncStatus("Archivio condiviso sincronizzato");
    render();
  }

  async function loadUserData(user) {
    const token = ++authLoadToken;
    const authGate = document.getElementById("authGate");
    const appShell = document.getElementById("appShell");
    authGate.hidden = true;
    appShell.hidden = true;
    document.getElementById("profileActions").hidden = true;
    document.getElementById("authRetry").hidden = false;
    setAuthMessage("Caricamento dell'archivio condiviso…");
    try {
      const userRef = doc(db, "users", user.uid);
      const userSnapshot = await getDoc(userRef);
      if (token !== authLoadToken) return;

      const storedCode = localStorage.getItem(RECOVERY_CODE_KEY + ":" + user.uid);
      let selectedState = null;
      let code = storedCode;

      if (code) {
        const recoveryRef = await getRecoveryDocumentRef(code);
        const sharedSnapshot = await getDoc(recoveryRef);
        if (token !== authLoadToken) return;
        if (sharedSnapshot.exists() && isValidState(sharedSnapshot.data().appState)) {
          selectedState = sharedSnapshot.data().appState;
        }
      }

      // Migrazione dei profili già esistenti: viene eseguita solo se non
      // è ancora disponibile un archivio condiviso associato al codice.
      if (!selectedState && userSnapshot.exists() && isValidState(userSnapshot.data().appState)) {
        selectedState = userSnapshot.data().appState;
      }

      if (!selectedState) {
        const cached = stateFromStorage(STORAGE_KEY + ":" + user.uid);
        const legacy = cached ? null : stateFromStorage(STORAGE_KEY);
        if (cached) selectedState = cached;
        else if (legacy && confirm("Ho trovato dati salvati in questo browser. Vuoi importarli nel tuo nuovo archivio condiviso?")) {
          selectedState = legacy;
        } else {
          showProfileSetup(user, token);
          return;
        }
      }

      if (token !== authLoadToken) return;
      code = code || getOrCreateRecoveryCode(user.uid);
      const recoveryRef = await getRecoveryDocumentRef(code);
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(recoveryRef);
        if (existing.exists() && isValidState(existing.data().appState)) {
          selectedState = existing.data().appState;
        } else {
          transaction.set(recoveryRef, {
            ownerUid: user.uid,
            appState: selectedState,
            updatedAt: Date.now()
          }, { merge: true });
        }
      });
      if (token !== authLoadToken) return;

      state = selectedState;
      currentUser = user;
      sharedRecoveryCode = code;
      lastSharedState = cloneState(state);
      pendingProfileUser = null;
      localStorage.setItem(RECOVERY_CODE_KEY + ":" + user.uid, code);
      try {
        localStorage.setItem(STORAGE_KEY + ":" + user.uid, JSON.stringify(state));
      } catch (e) {
        console.warn("Impossibile salvare la copia locale:", e);
      }
      document.getElementById("accountIdentity").textContent = "Archivio condiviso";
      document.getElementById("accountCode").textContent = "Codice personale: " + code;
      authGate.hidden = true;
      document.getElementById("profileActions").hidden = true;
      appShell.hidden = false;
      await listenToSharedArchive(code, user);
      setSyncStatus("Archivio condiviso sincronizzato");
      render();
    } catch (error) {
      if (token !== authLoadToken) return;
      console.error("Errore nel caricamento dell'archivio:", error);
      currentUser = null;
      sharedRecoveryCode = null;
      authGate.hidden = false;
      appShell.hidden = true;
      document.getElementById("profileActions").hidden = true;
      document.getElementById("authRetry").hidden = false;
      setAuthMessage(authErrorMessage(error), true);
    }
  }

  async function initializeAuthentication() {
    const retryButton = document.getElementById("authRetry");
    const createProfileButton = document.getElementById("createProfileBtn");
    const restoreProfileButton = document.getElementById("restoreProfileBtn");

    createProfileButton.addEventListener("click", async () => {
      if (!pendingProfileUser) return;
      createProfileButton.disabled = true;
      restoreProfileButton.disabled = true;
      setAuthMessage("Creazione del profilo…");
      try {
        await finishProfileSetup(pendingProfileUser, createDefaultState());
      } catch (error) {
        console.error("Errore creazione profilo:", error);
        setAuthMessage(authErrorMessage(error), true);
      } finally {
        createProfileButton.disabled = false;
        restoreProfileButton.disabled = false;
      }
    });

    restoreProfileButton.addEventListener("click", async () => {
      if (!pendingProfileUser) return;
      const file = document.getElementById("initialRestoreFile").files[0];
      const code = document.getElementById("restoreRecoveryCode").value.trim().toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{16}$/.test(code)) {
        setAuthMessage("Inserisci il codice personale di 16 caratteri.", true);
        return;
      }
      restoreProfileButton.disabled = true;
      createProfileButton.disabled = true;
      setAuthMessage("Ricerca del profilo tramite codice…");
      try {
        // Prima prova il recupero cloud con il solo codice.
        let restored = await findRecoverySnapshot(code);
        if (!restored && file) {
          setAuthMessage("Profilo cloud non trovato: provo il backup JSON…");
          restored = await readBackupFile(file, code);
        }
        if (!restored) {
          throw new Error("Nessun profilo trovato con questo codice. Se hai un backup JSON, selezionalo e riprova.");
        }
        if (!isValidState(restored)) throw new Error("I dati recuperati non sono un profilo Mensa Smart valido.");
        await finishProfileSetup(pendingProfileUser, restored, code);
        alert("Profilo ripristinato correttamente. Il file JSON non era necessario.");
      } catch (error) {
        console.error("Errore ripristino iniziale:", error);
        const message = error.name === "OperationError"
          ? "Codice errato oppure backup JSON danneggiato."
          : error.message;
        setAuthMessage(message, true);
      } finally {
        restoreProfileButton.disabled = false;
        createProfileButton.disabled = false;
      }
    });

    // Mantiene la sessione anonima nel browser anche dopo chiusura e riapertura.
    // È lo stesso criterio già adottato da Marvel Tracker.
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch (error) {
      setAuthMessage(authErrorMessage(error), true);
      return;
    }
    if (retryButton) {
      retryButton.addEventListener("click", () => {
        if (anonymousSignInPending) return;
        anonymousSignInPending = true;
        retryButton.disabled = true;
        setAuthMessage("Accesso in corso…");
        signInAnonymously(auth).catch((error) => {
          setAuthMessage(authErrorMessage(error), true);
        }).finally(() => {
          anonymousSignInPending = false;
          retryButton.disabled = false;
        });
      });
    }

    onAuthStateChanged(auth, (user) => {
      if (user) {
        void loadUserData(user);
        return;
      }
      authLoadToken++;
      stopSharedArchiveListener();
      currentUser = null;
      sharedRecoveryCode = null;
      lastSharedState = null;
      document.getElementById("appShell").hidden = true;
      document.getElementById("authGate").hidden = false;
      setAuthMessage("Accesso anonimo in corso…");
      if (anonymousSignInPending) return;
      anonymousSignInPending = true;
      signInAnonymously(auth).catch((error) => {
        setAuthMessage(authErrorMessage(error), true);
      }).finally(() => {
        anonymousSignInPending = false;
      });
    });
  }

  function formatEuro(num) {
    const val = Number(num) || 0;
    return val.toLocaleString("it-IT", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + " €";
  }

  function getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function sortMonths() {
    state.months.sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });
  }

  function getDayRecord(monthId, day) {
    if (!state.records[monthId]) state.records[monthId] = {};
    if (!state.records[monthId][day]) {
      state.records[monthId][day] = {
        lunch: false,
        lunchPay: false,
        lunchVoucher: false,
        dinner: false,
        dinnerPay: false,
        dinnerVoucher: false
      };
    }
    return state.records[monthId][day];
  }

  function computeAllStats() {
    sortMonths();
    let carryOver = 0;
    const statsMap = {};

    state.months.forEach((mObj) => {
      const daysCount = getDaysInMonth(mObj.year, mObj.month);
      let lunchCount = 0;
      let dinnerCount = 0;
      let payMealsCount = 0;
      let lunchVouchers = 0;
      let dinnerVouchers = 0;

      for (let d = 1; d <= daysCount; d++) {
        const rec = getDayRecord(mObj.id, d);
        if (rec.lunch) lunchCount++;
        if (rec.dinner) dinnerCount++;
        if (rec.lunchPay) payMealsCount++;
        if (rec.dinnerPay) payMealsCount++;
        if (rec.lunchVoucher) lunchVouchers++;
        if (rec.dinnerVoucher) dinnerVouchers++;
      }

      const costDue = Number((payMealsCount * state.mealPrice).toFixed(2));
      const paid = Number((parseFloat(state.payments[mObj.id]) || 0).toFixed(2));
      const balance = Number((carryOver + paid - costDue).toFixed(2));
      const totalVouchers = lunchVouchers + dinnerVouchers;
      const voucherValueTotal = Number((totalVouchers * state.voucherPrice).toFixed(2));

      statsMap[mObj.id] = {
        ...mObj,
        label: MONTH_NAMES[mObj.month] + " " + mObj.year,
        shortLabel: MONTH_NAMES[mObj.month].slice(0, 3) + " " + String(mObj.year).slice(2),
        daysCount,
        lunchCount,
        dinnerCount,
        totalConsumed: lunchCount + dinnerCount,
        payMealsCount,
        costDue,
        carryOver,
        paid,
        balance,
        lunchVouchers,
        dinnerVouchers,
        totalVouchers,
        voucherValueTotal
      };

      carryOver = balance;
    });

    return statsMap;
  }


  // Moduli personali: ore, recuperi, assenze, campi e promemoria.
  function ensureWorkData() {
    state.workEntries ||= []; state.overtimeAdjustments ||= []; state.leaveEntries ||= [];
    state.leaveConfig ||= { annualDays: 0, carriedDays: 0 };
    state.customFieldDefs ||= []; state.customFieldValues ||= {};
    state.reminders ||= [];
  }
  function minutesBetween(start, end) {
    if (!start || !end) return 0;
    const [sh,sm]=start.split(":").map(Number), [eh,em]=end.split(":").map(Number);
    let n=eh*60+em-(sh*60+sm); if(n<0)n+=1440; return Math.max(0,n);
  }
  function fmtHours(mins) { const sign=mins<0?"−":""; const n=Math.abs(Math.round(mins)); return sign+Math.floor(n/60)+"h "+String(n%60).padStart(2,"0")+"m"; }
  function renderWorkView() {
    ensureWorkData();
    const root=document.getElementById("appRoot");
    const rows=[...state.workEntries].sort((a,b)=>b.date.localeCompare(a.date));
    const total=rows.reduce((sum,x)=>sum+Number(x.workedMinutes||0),0);
    const overtime=rows.reduce((sum,x)=>sum+Number(x.overtimeMinutes||0),0);
    root.innerHTML=`<section class="personal-page"><h2>⏱️ Ore lavorate</h2><p class="personal-muted">Registra entrata, uscita e pause. Il saldo confronta le ore effettive con l'orario giornaliero previsto.</p>
      <form id="workForm" class="personal-form">
        <label>Data<input name="date" type="date" required value="${localDateKey(new Date())}"></label>
        <label>Entrata<input name="start" type="time" required value="08:00"></label>
        <label>Uscita<input name="end" type="time" required value="17:00"></label>
        <label>Pause (minuti)<input name="breakMinutes" type="number" min="0" value="60"></label>
        <label>Ore previste al giorno<input name="targetHours" type="number" min="0" max="24" step="0.25" value="8"></label>
        <label>Nota<input name="note" maxlength="300" placeholder="Facoltativa"></label>
        <button class="btn btn-primary" type="submit">＋ Registra giornata</button>
      </form>
      <div class="personal-kpis"><article><small>Ore lavorate totali</small><strong>${fmtHours(total)}</strong></article><article><small>Saldo straordinari</small><strong>${fmtHours(overtime)}</strong></article></div>
      <h3>Registro presenze</h3><div class="personal-table"><table><thead><tr><th>Data</th><th>Entrata–uscita</th><th>Pause</th><th>Lavorate</th><th>Saldo</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${escapeNoteHtml(x.date)}</td><td>${escapeNoteHtml(x.start)}–${escapeNoteHtml(x.end)}</td><td>${x.breakMinutes} min</td><td>${fmtHours(x.workedMinutes)}</td><td>${fmtHours(x.overtimeMinutes)}</td><td><button class="btn btn-danger" data-work-delete="${x.id}">Elimina</button></td></tr>`).join("")||'<tr><td colspan="6">Nessuna giornata registrata.</td></tr>'}</tbody></table></div></section>`;
    root.querySelector("#workForm").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget), date=f.get("date");if(state.workEntries.some(x=>x.date===date)){alert("Esiste già una registrazione per questa data. Eliminala prima di inserirne un'altra.");return;}const worked=Math.max(0,minutesBetween(f.get("start"),f.get("end"))-Number(f.get("breakMinutes")||0));const target=Math.round(Number(f.get("targetHours")||8)*60);state.workEntries.push({id:crypto.randomUUID(),date,start:f.get("start"),end:f.get("end"),breakMinutes:Number(f.get("breakMinutes")||0),workedMinutes:worked,overtimeMinutes:worked-target,targetMinutes:target,note:f.get("note")||""});saveState();render();});
    root.querySelectorAll("[data-work-delete]").forEach(b=>b.addEventListener("click",()=>{if(confirm("Eliminare la registrazione?")){state.workEntries=state.workEntries.filter(x=>x.id!==b.dataset.workDelete);saveState();render();}}));
  }
  function renderOvertimeView() {
    ensureWorkData();
    const rows=[...state.workEntries].sort((a,b)=>a.date.localeCompare(b.date));
    const calculated=rows.reduce((n,x)=>n+Number(x.overtimeMinutes||0),0);
    const adjustments=state.overtimeAdjustments.reduce((n,x)=>n+Number(x.minutes||0),0);
    const balance=calculated+adjustments;
    const root=document.getElementById("appRoot");
    root.innerHTML=`<section class="personal-page"><h2>⚖️ Straordinari e recuperi</h2><p class="personal-muted">Saldo progressivo calcolato sulle ore registrate, con possibilità di annotare recuperi o correzioni manuali.</p><div class="personal-kpis"><article><small>Saldo maturato</small><strong>${fmtHours(balance)}</strong></article><article><small>Da giornate registrate</small><strong>${fmtHours(calculated)}</strong></article></div>
      <form id="adjustForm" class="personal-form"><label>Data<input name="date" type="date" required value="${localDateKey(new Date())}"></label><label>Tipo<select name="kind"><option value="positive">Aggiungi ore</option><option value="negative">Recupero / sottrai ore</option></select></label><label>Ore<input name="hours" type="number" min="0.25" step="0.25" required></label><label>Motivo<input name="note" maxlength="300" placeholder="Motivo"></label><button class="btn btn-primary">＋ Registra movimento</button></form>
      <h3>Movimenti</h3><div class="personal-table"><table><thead><tr><th>Data</th><th>Descrizione</th><th>Variazione</th></tr></thead><tbody>${state.overtimeAdjustments.map(x=>`<tr><td>${escapeNoteHtml(x.date)}</td><td>${escapeNoteHtml(x.note||"Recupero")}</td><td>${fmtHours(x.minutes)}</td></tr>`).join("")||'<tr><td colspan="3">Nessun movimento manuale.</td></tr>'}</tbody></table></div></section>`;
    root.querySelector("#adjustForm").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget),entry={id:crypto.randomUUID(),date:f.get("date"),adjustmentMinutes:Math.round(Number(f.get("hours"))*60)*(f.get("kind")==="negative"?-1:1),note:f.get("note")||"Movimento manuale",workedMinutes:0,overtimeMinutes:0};state.overtimeAdjustments.push({id:entry.id,date:entry.date,minutes:entry.adjustmentMinutes,note:entry.note});saveState();render();});
  }
  function renderLeaveView() {
    ensureWorkData();const root=document.getElementById("appRoot"),cfg=state.leaveConfig;
    const used=state.leaveEntries.filter(x=>x.kind==="Ferie"||x.kind==="Permesso").reduce((n,x)=>n+Number(x.days||0),0),remaining=Number(cfg.annualDays||0)+Number(cfg.carriedDays||0)-used;
    root.innerHTML=`<section class="personal-page"><h2>🏖️ Ferie e permessi</h2><p class="personal-muted">Imposta il tuo monte giorni e registra ferie o permessi. Il residuo si aggiorna automaticamente.</p>
      <form id="leaveConfigForm" class="personal-form"><label>Giorni annuali maturati<input name="annualDays" type="number" min="0" step="0.5" value="${cfg.annualDays}"></label><label>Residuo riportato<input name="carriedDays" type="number" min="0" step="0.5" value="${cfg.carriedDays}"></label><button class="btn btn-secondary">Salva monte giorni</button></form>
      <div class="personal-kpis"><article><small>Giorni disponibili</small><strong>${remaining}</strong></article><article><small>Giorni utilizzati</small><strong>${used}</strong></article></div>
      <form id="leaveForm" class="personal-form"><label>Tipo<select name="kind"><option>Ferie</option><option>Permesso</option><option>Malattia</option><option>Altro</option></select></label><label>Dal<input name="start" type="date" required></label><label>Al<input name="end" type="date" required></label><label>Giorni da scalare<input name="days" type="number" min="0.5" step="0.5" required></label><label>Note<input name="note" maxlength="300"></label><button class="btn btn-primary">＋ Registra assenza</button></form>
      <div class="personal-table"><table><thead><tr><th>Tipo</th><th>Periodo</th><th>Giorni</th><th></th></tr></thead><tbody>${state.leaveEntries.map(x=>`<tr><td>${escapeNoteHtml(x.kind)}</td><td>${escapeNoteHtml(x.start)} – ${escapeNoteHtml(x.end)}</td><td>${x.days}</td><td><button class="btn btn-danger" data-leave-delete="${x.id}">Elimina</button></td></tr>`).join("")||'<tr><td colspan="4">Nessuna assenza registrata.</td></tr>'}</tbody></table></div></section>`;
    root.querySelector("#leaveConfigForm").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);cfg.annualDays=Number(f.get("annualDays")||0);cfg.carriedDays=Number(f.get("carriedDays")||0);saveState();render();});
    root.querySelector("#leaveForm").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);if(f.get("end")<f.get("start")){alert("La data finale precede quella iniziale.");return;}state.leaveEntries.push({id:crypto.randomUUID(),kind:f.get("kind"),start:f.get("start"),end:f.get("end"),days:Number(f.get("days")),note:f.get("note")||""});saveState();render();});
    root.querySelectorAll("[data-leave-delete]").forEach(b=>b.addEventListener("click",()=>{if(confirm("Eliminare questa assenza?")){state.leaveEntries=state.leaveEntries.filter(x=>x.id!==b.dataset.leaveDelete);saveState();render();}}));
  }
  function renderCustomFieldsView() {
    ensureWorkData();const root=document.getElementById("appRoot");
    root.innerHTML=`<section class="personal-page"><h2>🧩 Campi personalizzati</h2><p class="personal-muted">Crea campi aggiuntivi per annotare le informazioni che ti servono.</p>
      <form id="fieldForm" class="personal-form"><label>Nome del campo<input name="label" maxlength="60" required placeholder="Es. Reparto, sede, referente"></label><label>Tipo<select name="type"><option value="text">Testo</option><option value="date">Data</option><option value="number">Numero</option></select></label><button class="btn btn-primary">＋ Aggiungi campo</button></form>
      <div class="personal-form">${state.customFieldDefs.map(d=>`<label>${escapeNoteHtml(d.label)}<input data-custom-value="${d.id}" type="${d.type}" value="${escapeNoteHtml(state.customFieldValues[d.id]||"")}"></label><button class="btn btn-danger" data-field-delete="${d.id}">Elimina campo</button>`).join("")||"Nessun campo personalizzato creato."}<button class="btn btn-secondary" id="saveCustomValues">Salva valori</button></div></section>`;
    root.querySelector("#fieldForm").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);state.customFieldDefs.push({id:crypto.randomUUID(),label:f.get("label").trim(),type:f.get("type")});saveState();render();});
    root.querySelector("#saveCustomValues").addEventListener("click",()=>{root.querySelectorAll("[data-custom-value]").forEach(el=>state.customFieldValues[el.dataset.customValue]=el.value);saveState();alert("Valori salvati.");});
    root.querySelectorAll("[data-field-delete]").forEach(b=>b.addEventListener("click",()=>{if(confirm("Eliminare il campo e il suo valore?")){state.customFieldDefs=state.customFieldDefs.filter(x=>x.id!==b.dataset.fieldDelete);delete state.customFieldValues[b.dataset.fieldDelete];saveState();render();}}));
  }
  function renderRemindersView() {
    ensureWorkData();const root=document.getElementById("appRoot"),today=localDateKey(new Date());
    const rows=[...state.reminders].sort((a,b)=>a.date.localeCompare(b.date));
    root.innerHTML=`<section class="personal-page"><h2>🔔 Promemoria e scadenze</h2><p class="personal-muted">Annota ciò che non vuoi dimenticare e segna gli elementi completati.</p>
      <form id="reminderForm" class="personal-form"><label>Promemoria<input name="title" maxlength="160" required placeholder="Es. Rinnovo documento"></label><label>Scadenza<input name="date" type="date" required></label><label>Dettagli<input name="details" maxlength="1000"></label><button class="btn btn-primary">＋ Aggiungi promemoria</button></form>
      <div class="personal-list">${rows.map(x=>`<article class="personal-item ${x.done?"is-done":""}"><div><strong>${escapeNoteHtml(x.title)}</strong><small>${escapeNoteHtml(x.date)} ${x.date<today&&!x.done?" · SCADUTO":""}</small><p>${escapeNoteHtml(x.details||"")}</p></div><div><button class="btn btn-secondary" data-reminder-done="${x.id}">${x.done?"Riapri":"Completa"}</button> <button class="btn btn-danger" data-reminder-delete="${x.id}">Elimina</button></div></article>`).join("")||'<p class="notes-empty">Nessun promemoria inserito.</p>'}</div></section>`;
    root.querySelector("#reminderForm").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);state.reminders.push({id:crypto.randomUUID(),title:f.get("title").trim(),date:f.get("date"),details:f.get("details")||"",done:false});saveState();render();});
    root.querySelectorAll("[data-reminder-done]").forEach(b=>b.addEventListener("click",()=>{const x=state.reminders.find(r=>r.id===b.dataset.reminderDone);if(x)x.done=!x.done;saveState();render();}));
    root.querySelectorAll("[data-reminder-delete]").forEach(b=>b.addEventListener("click",()=>{if(confirm("Eliminare il promemoria?")){state.reminders=state.reminders.filter(x=>x.id!==b.dataset.reminderDelete);saveState();render();}}));
  }

  function renderTabs() {
    const container = document.getElementById("tabsContainer");
    if (!container) return;
    container.innerHTML = "";

    const sumBtn = document.createElement("button");
    sumBtn.type = "button";
    sumBtn.className = "tab-btn summary-tab" + (activeTab === "summary" ? " active" : "");
    sumBtn.textContent = "📊 Riepilogo Generale";
    sumBtn.addEventListener("click", () => {
      activeTab = "summary";
      render();
    });
    container.appendChild(sumBtn);

    const moduleTabs = [["work","⏱️ Ore lavorate"],["overtime","⚖️ Straordinari"],["leave","🏖️ Ferie e permessi"],["custom","🧩 Campi"],["reminders","🔔 Promemoria"]];
    moduleTabs.forEach(([key,label]) => { const btn=document.createElement("button"); btn.type="button"; btn.className="tab-btn"+(activeTab===key?" active":""); btn.textContent=label; btn.addEventListener("click",()=>{activeTab=key;render();}); container.appendChild(btn); });

    const notesBtn = document.createElement("button");
    notesBtn.type = "button";
    notesBtn.className = "tab-btn notes-tab" + (activeTab === "notes" ? " active" : "");
    notesBtn.textContent = "📝 Agenda / Note";
    notesBtn.addEventListener("click", () => {
      activeTab = "notes";
      render();
    });
    container.appendChild(notesBtn);

    const calendarBtn = document.createElement("button");
    calendarBtn.type = "button";
    calendarBtn.className = "tab-btn calendar-tab" + (activeTab === "calendar" ? " active" : "");
    calendarBtn.textContent = "📅 Calendario";
    calendarBtn.addEventListener("click", () => { activeTab = "calendar"; render(); });
    container.appendChild(calendarBtn);

    state.months.forEach((mObj) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab-btn" + (activeTab === mObj.id ? " active" : "");
      btn.textContent = MONTH_NAMES[mObj.month].slice(0, 3) + " " + mObj.year;
      btn.addEventListener("click", () => {
        activeTab = mObj.id;
        render();
      });
      container.appendChild(btn);
    });
  }

  function renderSummaryView(statsMap) {
    const root = document.getElementById("appRoot");
    let totConsumed = 0;
    let totPayMeals = 0;
    let totCostDue = 0;
    let totPaid = 0;
    let totVouchers = 0;
    let totVoucherValue = 0;
    let finalBalance = 0;

    state.months.forEach((mObj) => {
      const s = statsMap[mObj.id];
      totConsumed += s.totalConsumed;
      totPayMeals += s.payMealsCount;
      totCostDue += s.costDue;
      totPaid += s.paid;
      totVouchers += s.totalVouchers;
      totVoucherValue += s.voucherValueTotal;
      finalBalance = s.balance;
    });

    let statusClass = "green";
    let statusTitle = "SALDATO";
    if (finalBalance < -0.005) {
      statusClass = "red";
      statusTitle = "IN DEBITO di " + formatEuro(Math.abs(finalBalance));
    } else if (finalBalance > 0.005) {
      statusClass = "blue";
      statusTitle = "A CREDITO di " + formatEuro(finalBalance);
    }

    const maxChartVal = Math.max(
      10,
      ...state.months.map((m) => Math.max(statsMap[m.id].costDue, statsMap[m.id].paid, statsMap[m.id].voucherValueTotal))
    );

    let barsHtml = "";
    state.months.forEach((m) => {
      const s = statsMap[m.id];
      const hDue = Math.round((s.costDue / maxChartVal) * 145);
      const hPaid = Math.round((s.paid / maxChartVal) * 145);
      const hVouch = Math.round((s.voucherValueTotal / maxChartVal) * 145);
      barsHtml += `
        <div class="bar-group" data-open-month="${m.id}" title="${s.label}: Maturato ${formatEuro(s.costDue)} | Versato ${formatEuro(s.paid)} | Buoni ${formatEuro(s.voucherValueTotal)}">
          <div class="bars-pair">
            <div class="bar bar-due" style="height:${Math.max(3, hDue)}px"></div>
            <div class="bar bar-paid" style="height:${Math.max(3, hPaid)}px"></div>
            <div class="bar bar-voucher" style="height:${Math.max(3, hVouch)}px"></div>
          </div>
          <div class="bar-label">${s.shortLabel}</div>
        </div>
      `;
    });

    let rowsHtml = "";
    state.months.forEach((m) => {
      const s = statsMap[m.id];
      let badgeHtml = '<span class="badge badge-settled">SALDATO</span>';
      if (s.balance < -0.005) {
        badgeHtml = `<span class="badge badge-debt">DEBITO ${formatEuro(Math.abs(s.balance))}</span>`;
      } else if (s.balance > 0.005) {
        badgeHtml = `<span class="badge badge-credit">CREDITO ${formatEuro(s.balance)}</span>`;
      }

      rowsHtml += `
        <tr>
          <td class="text-left">
            <button type="button" class="btn btn-secondary" style="padding:5px 10px;" data-open-month="${m.id}">
              📅 ${s.label}
            </button>
          </td>
          <td>${s.lunchCount}</td>
          <td>${s.dinnerCount}</td>
          <td><strong>${s.payMealsCount}</strong></td>
          <td>${formatEuro(s.costDue)}</td>
          <td>${formatEuro(s.carryOver)}</td>
          <td>${formatEuro(s.paid)}</td>
          <td>${badgeHtml}</td>
          <td class="col-voucher"><strong>${s.totalVouchers}</strong> (${formatEuro(s.voucherValueTotal)})</td>
        </tr>
      `;
    });

    root.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Pasti Mensa da Pagare</div>
          <div class="kpi-value">${totPayMeals}</div>
          <div class="kpi-sub">Su ${totConsumed} pasti totali consumati</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Totale Maturato vs Versato</div>
          <div class="kpi-value">${formatEuro(totCostDue)}</div>
          <div class="kpi-sub">Già versati: ${formatEuro(totPaid)}</div>
        </div>
        <div class="kpi-card ${statusClass}">
          <div class="kpi-label">Situazione Attuale Mensa</div>
          <div class="kpi-value" style="font-size:1.3rem;">${statusTitle}</div>
          <div class="kpi-sub">Saldo netto progressivo</div>
        </div>
        <div class="kpi-card purple">
          <div class="kpi-label">Buoni Pasto Conteggiati</div>
          <div class="kpi-value" style="color:var(--purple);">${totVouchers} buoni</div>
          <div class="kpi-sub">Valore separato: ${formatEuro(totVoucherValue)}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>📈 Andamento Mensile (Clicca su un mese per aprirlo)</h2>
        </div>
        <div class="chart-box">
          <div class="chart-legend">
            <div class="legend-item"><span class="dot" style="background:var(--accent)"></span> Costo Mensa Maturato</div>
            <div class="legend-item"><span class="dot" style="background:var(--green)"></span> Importo Versato</div>
            <div class="legend-item"><span class="dot" style="background:var(--purple)"></span> Valore Buoni Pasto (Separato)</div>
          </div>
          <div class="chart-bars">${barsHtml}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>📋 Riepilogo Dettagliato per Mese</h2>
          <button type="button" class="btn btn-primary" id="btnAddMonthInline">+ Aggiungi Mese</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="text-left">Mese</th>
                <th>Pranzi</th>
                <th>Cene</th>
                <th>Da Pagare</th>
                <th>Costo Mese</th>
                <th>Riporto Prec.</th>
                <th>Versato</th>
                <th>Stato Mensa</th>
                <th class="col-voucher">Buoni Pasto (Separato)</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;

    root.querySelectorAll("[data-open-month]").forEach((el) => {
      el.addEventListener("click", () => {
        activeTab = el.getAttribute("data-open-month");
        render();
      });
    });

    const inlineAdd = document.getElementById("btnAddMonthInline");
    if (inlineAdd) {
      inlineAdd.addEventListener("click", openAddMonthModal);
    }
  }

  function renderMonthView(monthId, statsMap) {
    const root = document.getElementById("appRoot");
    const s = statsMap[monthId];
    if (!s) {
      activeTab = "summary";
      render();
      return;
    }

    let rowsHtml = "";
    for (let d = 1; d <= s.daysCount; d++) {
      const dateObj = new Date(s.year, s.month - 1, d);
      const dayOfWeek = dateObj.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const dateStr = String(d).padStart(2, "0") + "/" + String(s.month).padStart(2, "0") + "/" + s.year;
      const rec = getDayRecord(monthId, d);

      const dayMealsToPay = (rec.lunchPay ? 1 : 0) + (rec.dinnerPay ? 1 : 0);
      const dayCost = dayMealsToPay * state.mealPrice;

      rowsHtml += `
        <tr class="${isWeekend ? "weekend" : ""}">
          <td class="text-left"><strong>${dateStr}</strong></td>
          <td class="text-left">${DAY_NAMES[dayOfWeek]}</td>
          <td><input type="checkbox" data-day="${d}" data-field="lunch" ${rec.lunch ? "checked" : ""}></td>
          <td class="col-pay"><input type="checkbox" class="chk-pay" data-day="${d}" data-field="lunchPay" ${rec.lunchPay ? "checked" : ""}></td>
          <td class="col-voucher"><input type="checkbox" class="chk-voucher" data-day="${d}" data-field="lunchVoucher" ${rec.lunchVoucher ? "checked" : ""}></td>
          <td><input type="checkbox" data-day="${d}" data-field="dinner" ${rec.dinner ? "checked" : ""}></td>
          <td class="col-pay"><input type="checkbox" class="chk-pay" data-day="${d}" data-field="dinnerPay" ${rec.dinnerPay ? "checked" : ""}></td>
          <td class="col-voucher"><input type="checkbox" class="chk-voucher" data-day="${d}" data-field="dinnerVoucher" ${rec.dinnerVoucher ? "checked" : ""}></td>
          <td><strong>${dayMealsToPay}</strong></td>
          <td><strong>${formatEuro(dayCost)}</strong></td>
        </tr>
      `;
    }

    const totalDueWithCarry = Number((s.costDue - s.carryOver).toFixed(2));
    const remainingToSettle = Number(Math.max(0, totalDueWithCarry - s.paid).toFixed(2));

    let bannerClass = "status-settled";
    let bannerText = "✅ MESE SALDATO";
    if (s.balance < -0.005) {
      bannerClass = "status-debt";
      bannerText = "⚠️ IN DEBITO DI " + formatEuro(Math.abs(s.balance));
    } else if (s.balance > 0.005) {
      bannerClass = "status-credit";
      bannerText = "🔵 A CREDITO DI " + formatEuro(s.balance);
    }

    root.innerHTML = `
      <div class="month-layout">
        <div class="card">
          <div class="card-header">
            <h2>📅 Registro Giornaliero — ${s.label}</h2>
            <span style="font-size:0.84rem; color:var(--muted);">Spunta Pranzo/Cena per attivare "Da Pagare", oppure usa i Buoni separati</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="text-left">Data</th>
                  <th class="text-left">Giorno</th>
                  <th>Pranzo</th>
                  <th class="col-pay">Da Pagare P.</th>
                  <th class="col-voucher">Buono P.</th>
                  <th>Cena</th>
                  <th class="col-pay">Da Pagare C.</th>
                  <th class="col-voucher">Buono C.</th>
                  <th>Pasti Pag.</th>
                  <th>Costo</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        </div>

        <aside class="sidebar-sticky">
          <div class="card" style="margin-bottom:0;">
            <div class="card-header">
              <h2>💶 Conto Mensa — ${s.label}</h2>
            </div>
            <div style="padding:18px;">
              <div class="summary-row">
                <span>Pranzi / Cene consumati</span>
                <strong>${s.lunchCount} P / ${s.dinnerCount} C</strong>
              </div>
              <div class="summary-row">
                <span>Pasti da pagare (${formatEuro(state.mealPrice)})</span>
                <strong>${s.payMealsCount} pasti</strong>
              </div>
              <div class="summary-row">
                <span>Costo Mensa del mese</span>
                <strong>${formatEuro(s.costDue)}</strong>
              </div>
              <div class="summary-row">
                <span>Riporto mese precedente</span>
                <strong style="color:${s.carryOver < 0 ? "var(--red)" : s.carryOver > 0 ? "var(--accent)" : "inherit"}">
                  ${formatEuro(s.carryOver)}
                </strong>
              </div>

              <div class="paid-box">
                <label for="monthPaidInput">Importo Versato nel mese (€)</label>
                <div class="paid-input-row">
                  <input type="number" id="monthPaidInput" step="0.01" min="0" value="${s.paid.toFixed(2)}">
                  <button type="button" class="btn-settle ${remainingToSettle <= 0 ? "settled" : ""}" id="btnSettleMonth">
                    ${remainingToSettle > 0 ? "✅ Salda (" + formatEuro(remainingToSettle) + ")" : "✅ Saldato"}
                  </button>
                </div>
              </div>

              <div class="status-banner ${bannerClass}">
                ${bannerText}
              </div>

              ${state.months.length > 1 ? `<button type="button" class="btn-delete-month" id="btnDeleteMonth">🗑️ Elimina scheda ${s.label}</button>` : ""}
            </div>
          </div>

          <div class="card" style="margin-bottom:0; border-top: 4px solid var(--purple);">
            <div class="card-header">
              <h2 style="color:var(--purple);">🎟️ Conteggio Buoni Pasto</h2>
            </div>
            <div style="padding:18px;">
              <p style="font-size:0.8rem; color:var(--muted); margin-bottom:10px;">
                Calcolo separato: non modifica il debito della mensa.
              </p>
              <div class="summary-row">
                <span>Buoni Pranzo</span>
                <strong>${s.lunchVouchers}</strong>
              </div>
              <div class="summary-row">
                <span>Buoni Cena</span>
                <strong>${s.dinnerVouchers}</strong>
              </div>
              <div class="summary-row">
                <span>Totale Buoni del mese</span>
                <strong style="color:var(--purple);">${s.totalVouchers} buoni</strong>
              </div>
              <div class="summary-row">
                <span>Valore totale (${formatEuro(state.voucherPrice)})</span>
                <strong style="color:var(--purple); font-size:1.1rem;">${formatEuro(s.voucherValueTotal)}</strong>
              </div>
            </div>
          </div>
        </aside>
      </div>
    `;

    root.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const day = parseInt(e.target.getAttribute("data-day"), 10);
        const field = e.target.getAttribute("data-field");
        const checked = e.target.checked;
        const rec = getDayRecord(monthId, day);
        rec[field] = checked;

        if (field === "lunch") {
          rec.lunchPay = checked;
        } else if (field === "dinner") {
          rec.dinnerPay = checked;
        }

        saveState();
        render();
      });
    });

    const paidInput = document.getElementById("monthPaidInput");
    if (paidInput) {
      paidInput.addEventListener("change", (e) => {
        const val = parseFloat(e.target.value);
        state.payments[monthId] = isNaN(val) ? 0 : Number(val.toFixed(2));
        saveState();
        render();
      });
    }

    const settleBtn = document.getElementById("btnSettleMonth");
    if (settleBtn) {
      settleBtn.addEventListener("click", () => {
        const needed = Number(Math.max(0, s.costDue - s.carryOver).toFixed(2));
        state.payments[monthId] = needed;
        saveState();
        render();
      });
    }

    const delBtn = document.getElementById("btnDeleteMonth");
    if (delBtn) {
      delBtn.addEventListener("click", () => {
        if (confirm("Vuoi davvero eliminare la scheda di " + s.label + "?")) {
          state.months = state.months.filter((m) => m.id !== monthId);
          delete state.records[monthId];
          delete state.payments[monthId];
          activeTab = "summary";
          saveState();
          render();
        }
      });
    }
  }

  function escapeNoteHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  function renderNotesView() {
    if (!Array.isArray(state.notes)) state.notes = [];
    const root = document.getElementById("appRoot");
    const today = new Date().toISOString().slice(0, 10);
    const notes = [...state.notes].sort((a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      String(b.updatedAt || b.date || "").localeCompare(String(a.updatedAt || a.date || ""))
    );
    root.innerHTML = `
      <section class="notes-page">
        <div class="notes-heading">
          <div><h2>📝 Agenda · Note personali</h2><p>Appunti liberi, sincronizzati tra i tuoi dispositivi.</p></div>
          <span class="notes-count">${notes.length} ${notes.length === 1 ? "nota" : "note"}</span>
        </div>
        <form id="noteCreateForm" class="note-editor">
          <label for="noteTitle">Titolo</label>
          <input id="noteTitle" maxlength="120" placeholder="Titolo della nota (facoltativo)">
          <label for="noteDate">Data</label>
          <input id="noteDate" type="date" value="">
          <small>Lascia vuoto per una nota senza data.</small>
          <label for="noteBody">Nota</label>
          <textarea id="noteBody" rows="5" maxlength="10000" placeholder="Scrivi qui il tuo appunto…"></textarea>
          <button class="btn btn-primary" type="submit">＋ Salva nota</button>
        </form>
        <div class="notes-list">
          ${notes.length ? notes.map(note => `
            <article class="note-card${note.pinned ? " pinned" : ""}" data-note-id="${escapeNoteHtml(note.id)}">
              <div class="note-card-top"><time>${note.date ? escapeNoteHtml(note.date) : "Senza data"} </time>${note.pinned ? '<span class="note-pin">📌 In evidenza</span>' : ""}</div>
              <h3>${escapeNoteHtml(note.title || "Nota senza titolo")}</h3>
              <p class="note-content">${escapeNoteHtml(note.body).replace(/\n/g, "<br>")}</p>
              <div class="note-actions">
                <button type="button" class="btn btn-secondary" data-note-edit>✏️ Modifica</button>
                <button type="button" class="btn btn-secondary" data-note-pin>${note.pinned ? "📌 Togli evidenza" : "📌 Evidenzia"}</button>
                <button type="button" class="btn btn-danger" data-note-delete>🗑️ Elimina</button>
              </div>
            </article>`).join("") : '<div class="notes-empty">Ancora nessuna nota. Scrivi il tuo primo appunto qui sopra.</div>'}
        </div>
      </section>`;

    root.querySelector("#noteCreateForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const body = root.querySelector("#noteBody").value.trim();
      const title = root.querySelector("#noteTitle").value.trim();
      const date = root.querySelector("#noteDate").value || "";
      if (!body && !title) {
        alert("Scrivi almeno il titolo o il contenuto della nota.");
        return;
      }
      state.notes.push({ id: crypto.randomUUID(), title, body, date, pinned: false, updatedAt: new Date().toISOString() });
      saveState();
      render();
    });

    root.querySelectorAll("[data-note-id]").forEach(card => {
      const id = card.dataset.noteId;
      const note = state.notes.find(item => item.id === id);
      if (!note) return;
      card.querySelector("[data-note-edit]").addEventListener("click", () => {
        const title = prompt("Titolo della nota:", note.title || "");
        if (title === null) return;
        const body = prompt("Testo della nota:", note.body || "");
        if (body === null) return;
        const date = prompt("Data (AAAA-MM-GG):", note.date || today);
        if (date === null) return;
        note.title = title.trim();
        note.body = body;
        note.date = date;
        note.updatedAt = new Date().toISOString();
        saveState();
        render();
      });
      card.querySelector("[data-note-pin]").addEventListener("click", () => {
        note.pinned = !note.pinned;
        note.updatedAt = new Date().toISOString();
        saveState();
        render();
      });
      card.querySelector("[data-note-delete]").addEventListener("click", () => {
        if (!confirm("Eliminare questa nota?")) return;
        state.notes = state.notes.filter(item => item.id !== id);
        saveState();
        render();
      });
    });
  }

  function localDateKey(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }
  function calendarDateLabel(date, includeYear = true) {
    return date.toLocaleDateString("it-IT", { day: "numeric", month: "long", ...(includeYear ? { year: "numeric" } : {}) });
  }
  function calendarDayNotes(date) {
    if (!Array.isArray(state.notes)) return [];
    return state.notes.filter(note => note.date === localDateKey(date));
  }
  function renderCalendarView() {
    const root = document.getElementById("appRoot");
    const cursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), calendarCursor.getDate());
    let heading = "", dates = [];
    if (calendarMode === "month") {
      heading = cursor.toLocaleDateString("it-IT", { month: "long", year: "numeric" });
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const start = new Date(first); start.setDate(1 - first.getDay());
      dates = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
    } else if (calendarMode === "week") {
      const start = new Date(cursor); start.setDate(cursor.getDate() - cursor.getDay());
      const end = new Date(start); end.setDate(end.getDate() + 6);
      heading = calendarDateLabel(start, false) + " – " + calendarDateLabel(end);
      dates = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
    } else {
      heading = cursor.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      dates = [cursor];
    }
    const selectedKey = localDateKey(cursor), todayKey = localDateKey(new Date());
    const dayNames = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
    const cells = dates.map(date => {
      const key = localDateKey(date), count = calendarDayNotes(date).length;
      const outside = calendarMode === "month" && date.getMonth() !== cursor.getMonth();
      return `<button type="button" class="calendar-day${outside ? " outside-month" : ""}${key === selectedKey ? " selected" : ""}${key === todayKey ? " today" : ""}" data-calendar-date="${key}">
        <span class="calendar-day-number">${date.getDate()}</span>${count ? `<span class="calendar-note-count">📝 ${count}</span>` : ""}
      </button>`;
    }).join("");
    const selectedNotes = calendarDayNotes(cursor);
    root.innerHTML = `
      <section class="calendar-page">
        <div class="calendar-heading"><h2>📅 Calendario</h2><p>Le note con una data sono visibili qui.</p></div>
        <div class="calendar-toolbar">
          <div class="calendar-nav"><button type="button" class="btn btn-secondary" data-calendar-prev>‹</button><button type="button" class="btn btn-secondary" data-calendar-today>Oggi</button><button type="button" class="btn btn-secondary" data-calendar-next>›</button></div>
          <h3>${heading}</h3>
          <div class="calendar-modes"><button type="button" class="btn ${calendarMode === "month" ? "btn-primary" : "btn-secondary"}" data-calendar-mode="month">Mese</button><button type="button" class="btn ${calendarMode === "week" ? "btn-primary" : "btn-secondary"}" data-calendar-mode="week">Settimana</button><button type="button" class="btn ${calendarMode === "day" ? "btn-primary" : "btn-secondary"}" data-calendar-mode="day">Giorno</button></div>
        </div>
        ${calendarMode !== "day" ? `<div class="calendar-weekdays">${dayNames.map(n => `<span>${n}</span>`).join("")}</div>` : ""}
        <div class="calendar-grid ${calendarMode}">${cells}</div>
        <section class="calendar-selected-notes"><h3>Note del ${calendarDateLabel(cursor)}</h3>
          ${selectedNotes.length ? selectedNotes.map(note => `<article class="calendar-note"><strong>${escapeNoteHtml(note.title || "Nota senza titolo")}</strong><p>${escapeNoteHtml(note.body || "").replace(/\n/g, "<br>")}</p>${note.pinned ? "<span>📌 In evidenza</span>" : ""}</article>`).join("") : '<p class="notes-empty">Nessuna nota per questa data.</p>'}
          <button type="button" class="btn btn-primary" id="calendarAddNote">＋ Aggiungi una nota per questo giorno</button>
        </section>
      </section>`;
    root.querySelectorAll("[data-calendar-date]").forEach(button => button.addEventListener("click", () => {
      const [y,m,d] = button.dataset.calendarDate.split("-").map(Number);
      calendarCursor = new Date(y, m - 1, d); render();
    }));
    root.querySelectorAll("[data-calendar-mode]").forEach(button => button.addEventListener("click", () => { calendarMode = button.dataset.calendarMode; render(); }));
    root.querySelector("[data-calendar-today]").addEventListener("click", () => { calendarCursor = new Date(); render(); });
    const shift = calendarMode === "month" ? -1 : calendarMode === "week" ? -7 : -1;
    root.querySelector("[data-calendar-prev]").addEventListener("click", () => {
      if (calendarMode === "month") { calendarCursor.setDate(1); calendarCursor.setMonth(calendarCursor.getMonth() - 1); }
      else calendarCursor.setDate(calendarCursor.getDate() + shift);
      render();
    });
    root.querySelector("[data-calendar-next]").addEventListener("click", () => {
      if (calendarMode === "month") { calendarCursor.setDate(1); calendarCursor.setMonth(calendarCursor.getMonth() + 1); }
      else calendarCursor.setDate(calendarCursor.getDate() + (calendarMode === "week" ? 7 : 1));
      render();
    });
    root.querySelector("#calendarAddNote").addEventListener("click", () => {
      activeTab = "notes"; render();
      const dateField = document.getElementById("noteDate"); if (dateField) dateField.value = selectedKey;
      const bodyField = document.getElementById("noteBody"); if (bodyField) bodyField.focus();
    });
  }

  function render() {
    const mealInput = document.getElementById("mealPrice");
    const voucherInput = document.getElementById("voucherPrice");
    if (mealInput) mealInput.value = Number(state.mealPrice).toFixed(2);
    if (voucherInput) voucherInput.value = Number(state.voucherPrice).toFixed(2);

    const statsMap = computeAllStats();
    renderTabs();

    if (activeTab === "summary") {
      renderSummaryView(statsMap);
    } else if (activeTab === "notes") {
      renderNotesView();
    } else if (activeTab === "calendar") {
      renderCalendarView();
    } else if (activeTab === "work") { renderWorkView();
    } else if (activeTab === "overtime") { renderOvertimeView();
    } else if (activeTab === "leave") { renderLeaveView();
    } else if (activeTab === "custom") { renderCustomFieldsView();
    } else if (activeTab === "reminders") { renderRemindersView();
    } else {
      renderMonthView(activeTab, statsMap);
    }
  }

  function openAddMonthModal() {
    sortMonths();
    const last = state.months[state.months.length - 1];
    let nextMonth = 1;
    let nextYear = 2028;
    if (last) {
      if (last.month === 12) {
        nextMonth = 1;
        nextYear = last.year + 1;
      } else {
        nextMonth = last.month + 1;
        nextYear = last.year;
      }
    }
    document.getElementById("selectMonth").value = String(nextMonth);
    document.getElementById("inputYear").value = String(nextYear);
    document.getElementById("monthModal").classList.add("open");
  }

  function closeAddMonthModal() {
    document.getElementById("monthModal").classList.remove("open");
  }

  document.addEventListener("DOMContentLoaded", () => {
    initializeAuthentication();
    document.getElementById("mealPrice").addEventListener("change", (e) => {
      const val = parseFloat(e.target.value);
      state.mealPrice = isNaN(val) || val < 0 ? 3.10 : val;
      saveState();
      render();
    });

    document.getElementById("voucherPrice").addEventListener("change", (e) => {
      const val = parseFloat(e.target.value);
      state.voucherPrice = isNaN(val) || val < 0 ? 3.10 : val;
      saveState();
      render();
    });

    document.getElementById("btnOpenModal").addEventListener("click", openAddMonthModal);
    document.getElementById("btnCloseModal").addEventListener("click", closeAddMonthModal);
    document.getElementById("btnCancelModal").addEventListener("click", closeAddMonthModal);

    document.getElementById("btnConfirmAddMonth").addEventListener("click", () => {
      const m = parseInt(document.getElementById("selectMonth").value, 10);
      const y = parseInt(document.getElementById("inputYear").value, 10);
      if (isNaN(y) || y < 2020 || y > 2099) {
        alert("Inserisci un anno valido.");
        return;
      }
      const id = y + "-" + String(m).padStart(2, "0");
      const exists = state.months.some((item) => item.id === id);
      if (exists) {
        alert("Questo mese è già presente! Verrà aperto direttamente.");
      } else {
        state.months.push({ id, year: y, month: m });
        sortMonths();
        saveState();
      }
      activeTab = id;
      closeAddMonthModal();
      render();
    });

    document.getElementById("btnExportCsv").addEventListener("click", () => {
      const statsMap = computeAllStats();
      const lines = [
        "Mese;Pranzi;Cene;Pasti da Pagare;Costo Mensa (€);Riporto Precedente (€);Versato (€);Saldo Finale (€);Buoni Pasto N.;Valore Buoni (€)"
      ];
      state.months.forEach((m) => {
        const s = statsMap[m.id];
        lines.push([
          s.label,
          s.lunchCount,
          s.dinnerCount,
          s.payMealsCount,
          s.costDue.toFixed(2).replace(".", ","),
          s.carryOver.toFixed(2).replace(".", ","),
          s.paid.toFixed(2).replace(".", ","),
          s.balance.toFixed(2).replace(".", ","),
          s.totalVouchers,
          s.voucherValueTotal.toFixed(2).replace(".", ",")
        ].join(";"));
      });
      const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Riepilogo_Mensa_e_Buoni.csv";
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("btnBackupJson").addEventListener("click", async () => {
      try {
        if (!currentUser) throw new Error("Account non ancora pronto.");
        const code = getOrCreateRecoveryCode(currentUser.uid);
        const encryptedBackup = await createEncryptedBackup(state, code);
        const blob = new Blob([JSON.stringify(encryptedBackup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "Backup_Mensa_Smart_Cifrato.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        alert("Backup cifrato scaricato. Conserva insieme il file e il tuo codice personale di 16 caratteri.");
      } catch (error) {
        console.error("Errore creazione backup:", error);
        alert("Non è stato possibile creare il backup: " + error.message);
      }
    });

    document.getElementById("btnCopyRecoveryCode").addEventListener("click", async () => {
      try {
        const code = getOrCreateRecoveryCode(currentUser.uid);
        await navigator.clipboard.writeText(code);
        alert("Codice personale copiato.");
      } catch (error) {
        alert("Copia automatica non disponibile. Seleziona e copia il codice mostrato.");
      }
    });

    // Azzera solo la copia locale e chiude la sessione; Firestore resta intatto.
    document.getElementById("btnResetAndExit").addEventListener("click", async () => {
      if (!currentUser) return;
      const confirmed = confirm("Vuoi uscire e azzerare la memoria locale di questo dispositivo?\\n\\nI dati e il codice salvati in questo browser verranno rimossi. I dati online su Firebase NON verranno cancellati. Per recuperarli basterà il codice personale; il backup JSON è facoltativo.");
      if (!confirmed) return;
      const uid = currentUser.uid;
      try {
        clearTimeout(remoteSaveTimer);
        stopSharedArchiveListener();
        sharedRecoveryCode = null;
        lastSharedState = null;
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STORAGE_KEY + ":" + uid);
        localStorage.removeItem(RECOVERY_CODE_KEY + ":" + uid);
        await signOut(auth);
      } catch (error) {
        console.error("Errore durante uscita e reset locale:", error);
        alert("Non è stato possibile completare l'uscita: " + error.message);
      }
    });

    document.getElementById("btnRestoreJson").addEventListener("click", () => {
      document.getElementById("restoreFileInput").click();
    });

    document.getElementById("restoreFileInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const firstText = await file.text();
        const firstParsed = JSON.parse(firstText);
        let parsed;
        let restoredRecoveryCode = null;
        if (firstParsed && firstParsed.format === BACKUP_FORMAT) {
          const code = prompt("Inserisci il codice personale di 16 caratteri associato al backup:");
          if (code === null) return;
          restoredRecoveryCode = code.trim().toUpperCase();
          parsed = await readBackupFile(file, restoredRecoveryCode);
        } else {
          parsed = firstParsed;
        }
        if (!isValidState(parsed)) throw new Error("Il file non contiene un backup Mensa Smart valido.");
        if (!confirm("Il ripristino sostituirà i dati attualmente presenti su questo dispositivo e sul relativo account Firebase. Vuoi continuare?")) return;
        state = parsed;
        activeTab = "summary";
        if (!currentUser) throw new Error("Sessione Firebase non disponibile.");
        clearTimeout(remoteSaveTimer);
        const activeRecoveryCode = restoredRecoveryCode || sharedRecoveryCode || getOrCreateRecoveryCode(currentUser.uid);
        const recoveryRef = await getRecoveryDocumentRef(activeRecoveryCode);
        await runTransaction(db, async (transaction) => {
          transaction.set(recoveryRef, {
            ownerUid: currentUser.uid,
            appState: state,
            updatedAt: Date.now()
          }, { merge: true });
        });
        sharedRecoveryCode = activeRecoveryCode;
        lastSharedState = cloneState(state);
        localStorage.setItem(STORAGE_KEY + ":" + currentUser.uid, JSON.stringify(state));
        localStorage.setItem(RECOVERY_CODE_KEY + ":" + currentUser.uid, activeRecoveryCode);
        document.getElementById("accountCode").textContent = "Codice personale: " + activeRecoveryCode;
        await listenToSharedArchive(activeRecoveryCode, currentUser);
        render();
        setSyncStatus("Backup ripristinato nell'archivio condiviso");
        alert("Backup ripristinato con successo su questo dispositivo.");
      } catch (error) {
        console.error("Errore ripristino backup:", error);
        const message = error.name === "OperationError"
          ? "Codice errato o file danneggiato. Controlla il codice personale e riprova."
          : error.message;
        alert("Ripristino non riuscito: " + message);
      } finally {
        e.target.value = "";
      }
    });

    render();
  });
})();
