import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB69-Y42-OqXnbqaJkJWBERJJaklbTPEQo",
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
      payments: {}
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
  let currentUser = null;
  let anonymousSignInPending = false;
  let remoteSaveTimer = null;
  let authLoadToken = 0;

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
    if (!currentUser) return;

    const user = currentUser;
    const snapshot = JSON.parse(JSON.stringify(state));
    setSyncStatus("Salvataggio…");
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(async () => {
      try {
        await setDoc(doc(db, "users", user.uid), {
          userCode: "MS-" + user.uid,
          appState: snapshot,
          updatedAt: Date.now()
        }, { merge: true });
        if (currentUser && currentUser.uid === user.uid) setSyncStatus("Salvato su Firebase");
      } catch (error) {
        console.error("Errore durante il salvataggio su Firebase:", error);
        if (currentUser && currentUser.uid === user.uid) setSyncStatus("Errore di sincronizzazione");
      }
    }, 600);
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

  async function loadUserData(user) {
    const token = ++authLoadToken;
    const authGate = document.getElementById("authGate");
    const appShell = document.getElementById("appShell");
    authGate.hidden = true;
    appShell.hidden = true;
    setAuthMessage("Caricamento dei dati…");
    try {
      const userRef = doc(db, "users", user.uid);
      const remoteSnapshot = await getDoc(userRef);
      if (token !== authLoadToken) return;

      if (remoteSnapshot.exists() && isValidState(remoteSnapshot.data().appState)) {
        state = remoteSnapshot.data().appState;
      } else {
        const cached = stateFromStorage(STORAGE_KEY + ":" + user.uid);
        const legacy = cached ? null : stateFromStorage(STORAGE_KEY);
        if (cached) {
          state = cached;
        } else if (legacy && confirm("Ho trovato dati salvati in questo browser. Vuoi importarli nel tuo nuovo account Firebase?")) {
          state = legacy;
        } else {
          state = createDefaultState();
        }
        await setDoc(userRef, {
          userCode: "MS-" + user.uid,
          appState: state,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }, { merge: true });
      }
      if (token !== authLoadToken) return;

      currentUser = user;
      try {
        localStorage.setItem(STORAGE_KEY + ":" + user.uid, JSON.stringify(state));
      } catch (e) {
        console.warn("Impossibile salvare la copia locale:", e);
      }
      document.getElementById("accountIdentity").textContent = "Sessione anonima";
      document.getElementById("accountCode").textContent = "Codice personale: MS-" + user.uid;
      authGate.hidden = true;
      appShell.hidden = false;
      setSyncStatus("Sincronizzato con Firebase");
      render();
    } catch (error) {
      if (token !== authLoadToken) return;
      console.error("Errore nel caricamento dell’account:", error);
      currentUser = null;
      authGate.hidden = false;
      appShell.hidden = true;
      setAuthMessage(authErrorMessage(error), true);
    }
  }

  function initializeAuthentication() {
    const retryButton = document.getElementById("authRetry");
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
      currentUser = null;
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

  function render() {
    const mealInput = document.getElementById("mealPrice");
    const voucherInput = document.getElementById("voucherPrice");
    if (mealInput) mealInput.value = Number(state.mealPrice).toFixed(2);
    if (voucherInput) voucherInput.value = Number(state.voucherPrice).toFixed(2);

    const statsMap = computeAllStats();
    renderTabs();

    if (activeTab === "summary") {
      renderSummaryView(statsMap);
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

    document.getElementById("btnBackupJson").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Backup_Mensa.json";
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("btnRestoreJson").addEventListener("click", () => {
      document.getElementById("restoreFileInput").click();
    });

    document.getElementById("restoreFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (parsed && Array.isArray(parsed.months)) {
            state = parsed;
            activeTab = "summary";
            saveState();
            render();
            alert("Backup ripristinato con successo!");
          } else {
            alert("File di backup non valido.");
          }
        } catch (err) {
          alert("Errore durante la lettura del file JSON.");
        }
      };
      reader.readAsText(file);
    });

    render();
  });
})();
