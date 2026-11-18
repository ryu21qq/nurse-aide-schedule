/**
 * ナースエイド勤務表 メインアプリケーション (app.js)
 */
(function (global) {
  const STORAGE_KEY = "nurse_aide_schedule_app_v2";

  // 初期サンプルスタッフ（10名未満：常勤6名＋パート1名＝計7名）
  const DEFAULT_STAFF = [
    {
      id: "st_1",
      name: "佐藤 美咲",
      employmentType: "full",
      nightShiftMax: 6,
      hasPersonalNightLimit: false,
      personalNightMax: 6,
      note: "リーダー"
    },
    {
      id: "st_2",
      name: "鈴木 健太",
      employmentType: "full",
      nightShiftMax: 6,
      hasPersonalNightLimit: false,
      personalNightMax: 6,
      note: ""
    },
    {
      id: "st_3",
      name: "高橋 由美",
      employmentType: "full",
      nightShiftMax: 6,
      hasPersonalNightLimit: false,
      personalNightMax: 6,
      note: ""
    },
    {
      id: "st_4",
      name: "田中 陽子",
      employmentType: "full",
      nightShiftMax: 6,
      hasPersonalNightLimit: false,
      personalNightMax: 6,
      note: ""
    },
    {
      id: "st_5",
      name: "渡辺 彩",
      employmentType: "full",
      nightShiftMax: 6,
      hasPersonalNightLimit: false,
      personalNightMax: 6,
      note: ""
    },
    {
      id: "st_6",
      name: "伊藤 真理",
      employmentType: "full",
      nightShiftMax: 6,
      hasPersonalNightLimit: true,
      personalNightMax: 4,
      note: "家庭事情により夜勤月4回まで"
    },
    {
      id: "st_7",
      name: "中村 久美子",
      employmentType: "part",
      nightShiftMax: 0,
      hasPersonalNightLimit: false,
      personalNightMax: 0,
      note: "パート(8:30-14:00・土日祝休)"
    }
  ];

  const AUTH_SESSION_KEY = "nurse_aide_schedule_auth_session_v1";

  // アプリケーション状態
  let appData = {
    currentYear: 2026,
    currentMonth: 12,
    staffList: [],
    schedulesByMonth: {}, // { "2026-12": { holidays: [], prevMonth: {}, cells: {} } }
    authConfig: {
      enabled: true,
      passcode: "2026",
      inviteToken: "na_inv_2026_k9x4m"
    }
  };

  function ensureAuthConfig() {
    if (!appData.authConfig) {
      appData.authConfig = {
        enabled: true,
        passcode: "2026",
        inviteToken: "na_inv_2026_k9x4m"
      };
    }
    if (!appData.authConfig.passcode) appData.authConfig.passcode = "2026";
    if (!appData.authConfig.inviteToken) {
      appData.authConfig.inviteToken = "na_inv_" + Math.random().toString(36).slice(2, 11);
    }
  }

  let uiState = {
    activeTool: "D", // "D" | "N" | "M" | "OFF" | "PAID" | "TRAIN" | "LOCK"
    autoLockOnEdit: true,
    autoNightSet: true // 「夜」入力時に翌日「明」・翌々日「休」を自動セット
  };

  function getMonthKey(year, month) {
    return `${year}-${String(month).padStart(2, "0")}`;
  }

  /**
   * 指定年月の空スケジュールデータを初期化して返す
   */
  function createEmptyMonthSchedule(year, month, staffList) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const holidays = HolidayUtils.getDefaultHolidaysForMonth(year, month);
    const dayCounts = HolidayUtils.getMonthDayCounts(year, month, holidays);
    const baseWeeklyOff = dayCounts.holidayAndWeekendDays;
    const isWeeklyOffManual = false;
    const staffWeeklyOff = {};
    const prevMonth = {};
    const cells = {};

    for (const st of staffList) {
      prevMonth[st.id] = { prev2: "OFF", prev1: "OFF" };
      cells[st.id] = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, holidays);
        if (st.employmentType === "part" && isHol) {
          cells[st.id][d] = { shift: "OFF", locked: true };
        } else {
          cells[st.id][d] = { shift: "OFF", locked: false };
        }
      }
    }

    return { holidays, baseWeeklyOff, isWeeklyOffManual, staffWeeklyOff, prevMonth, cells };
  }

  /**
   * 現在の月次スケジュールオブジェクトを取得（なければ生成）
   */
  function getCurrentSchedule() {
    const key = getMonthKey(appData.currentYear, appData.currentMonth);
    if (!appData.schedulesByMonth[key]) {
      appData.schedulesByMonth[key] = createEmptyMonthSchedule(
        appData.currentYear,
        appData.currentMonth,
        appData.staffList
      );
    }
    const sched = appData.schedulesByMonth[key];
    const daysInMonth = new Date(appData.currentYear, appData.currentMonth, 0).getDate();

    if (typeof sched.baseWeeklyOff !== "number" || isNaN(sched.baseWeeklyOff)) {
      const dc = HolidayUtils.getMonthDayCounts(
        appData.currentYear,
        appData.currentMonth,
        sched.holidays
      );
      sched.baseWeeklyOff = dc.holidayAndWeekendDays;
    }
    if (!sched.staffWeeklyOff) sched.staffWeeklyOff = {};

    // スタッフ追加・変更時の整合性確保
    if (!sched.prevMonth) sched.prevMonth = {};
    if (!sched.cells) sched.cells = {};
    for (const st of appData.staffList) {
      if (!sched.prevMonth[st.id]) {
        sched.prevMonth[st.id] = { prev2: "OFF", prev1: "OFF" };
      }
      if (!sched.cells[st.id]) {
        sched.cells[st.id] = {};
      }
      for (let d = 1; d <= daysInMonth; d++) {
        if (!sched.cells[st.id][d]) {
          const isHol = HolidayUtils.isHolidayOrWeekend(
            appData.currentYear,
            appData.currentMonth,
            d,
            sched.holidays
          );
          sched.cells[st.id][d] = {
            shift: "OFF",
            locked: st.employmentType === "part" && isHol
          };
        }
      }
    }
    return sched;
  }

  function saveToStorage() {
    try {
      const jsonStr = JSON.stringify(appData);
      localStorage.setItem(STORAGE_KEY, jsonStr);
      if (window.location.protocol === "http:" || window.location.protocol === "https:") {
        fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: jsonStr
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("Failed to save to storage:", e);
    }
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.staffList) && parsed.staffList.length > 0) {
          appData = parsed;
          return true;
        }
      }
    } catch (e) {
      console.warn("Failed to load from localStorage:", e);
    }
    return false;
  }

  /**
   * 前月末の勤務変更時に当月1日・2日の「明」「休」を連動更新する
   */
  function applyPrevMonthCarryover(staffId) {
    const sched = getCurrentSchedule();
    const prev1 = sched.prevMonth[staffId].prev1;
    const prev2 = sched.prevMonth[staffId].prev2;

    // 前々月末が「夜」なら前月末は自動的に「明」にする
    if (prev2 === "N" && prev1 !== "M") {
      sched.prevMonth[staffId].prev1 = "M";
    }

    const updatedPrev1 = sched.prevMonth[staffId].prev1;
    if (updatedPrev1 === "N") {
      sched.cells[staffId][1] = { shift: "M", locked: true };
      sched.cells[staffId][2] = { shift: "OFF", locked: true };
    } else if (updatedPrev1 === "M") {
      sched.cells[staffId][1] = { shift: "OFF", locked: true };
    }
  }

  /**
   * セルのクリック操作処理
   */
  function handleCellClick(staffId, day) {
    const sched = getCurrentSchedule();
    const staff = appData.staffList.find((s) => s.id === staffId);
    if (!staff) return;

    const daysInMonth = new Date(appData.currentYear, appData.currentMonth, 0).getDate();
    const cell = sched.cells[staffId][day];

    // ロック切替ツール選択時
    if (uiState.activeTool === "LOCK") {
      cell.locked = !cell.locked;
      if (!cell.locked && !cell.noNight && !cell.mOrOff) {
        cell.isManual = false;
      }
      saveToStorage();
      renderAll();
      return;
    }

    const shiftCode = uiState.activeTool;

    // 「夜勤以外(NO_N)」スタンプ選択時
    if (shiftCode === "NO_N") {
      if (staff.employmentType === "part") {
        alert("パートスタッフは元から夜勤対象外（日勤・休みのみ）です。");
        return;
      }
      if (cell.noNight && cell.shift === "NO_N") {
        // 再クリックで解除
        cell.noNight = false;
        cell.mOrOff = false;
        cell.isManual = false;
        cell.shift = "OFF";
        cell.locked = false;
      } else {
        cell.noNight = true;
        cell.mOrOff = false;
        cell.isManual = true;
        cell.shift = "NO_N";
        cell.locked = false;
      }
      saveToStorage();
      renderAll();
      return;
    }

    // 「明/休(M_OFF)」スタンプ選択時
    if (shiftCode === "M_OFF") {
      if (staff.employmentType === "part") {
        alert("パートスタッフには「明」がないため、「休」スタンプをご利用ください。");
        return;
      }
      if (cell.mOrOff && cell.shift === "M_OFF") {
        // 再クリックで解除
        cell.mOrOff = false;
        cell.noNight = false;
        cell.isManual = false;
        cell.shift = "OFF";
        cell.locked = false;
      } else {
        cell.mOrOff = true;
        cell.noNight = false;
        cell.isManual = true;
        cell.shift = "M_OFF";
        cell.locked = false;
      }
      saveToStorage();
      renderAll();
      return;
    }

    // パートに夜勤・明けは入力不可
    if (staff.employmentType === "part" && (shiftCode === "N" || shiftCode === "M")) {
      alert("パートスタッフには「夜」「明」は割り当てできません。");
      return;
    }

    // パートの土日祝に日勤は入力不可
    const isHol = HolidayUtils.isHolidayOrWeekend(
      appData.currentYear,
      appData.currentMonth,
      day,
      sched.holidays
    );
    if (staff.employmentType === "part" && isHol && shiftCode === "D") {
      alert("パートスタッフは土日祝休みのルールのため、休日に「日」は割り当てできません。");
      return;
    }

    // 「年」スタンプ選択時：既に「年」指定されていたマスを再クリックした場合は解除
    if (shiftCode === "PAID") {
      if (cell.paidRequest) {
        cell.paidRequest = false;
        cell.forceOffOnPaidReq = false;
        cell.autoMovedPaid = false;
        cell.shift = "OFF";
        cell.locked = false;
        cell.isManual = false;
        // 自動振替されていた「年」が1つあれば解除して「休」に戻す
        for (let d2 = 1; d2 <= daysInMonth; d2++) {
          if (sched.cells[staffId][d2] && sched.cells[staffId][d2].autoMovedPaid) {
            sched.cells[staffId][d2] = {
              shift: "OFF",
              locked: false,
              isManual: false,
              autoMovedPaid: false
            };
            break;
          }
        }
      } else {
        cell.shift = "PAID";
        cell.paidRequest = true;
        cell.forceOffOnPaidReq = false;
        cell.autoMovedPaid = false;
        cell.noNight = false;
        cell.mOrOff = false;
        cell.isManual = true;
        if (uiState.autoLockOnEdit) {
          cell.locked = true;
        }
      }
      saveToStorage();
      renderAll();
      return;
    }

    // 「年」が入力されていたマスを「休」にした場合 → このマスを「休」にし、別の休日に「年」をつける
    const wasPaidRequest = Boolean(
      cell.paidRequest || (cell.shift === "PAID" && !cell.autoMovedPaid)
    );
    if (shiftCode === "OFF" && wasPaidRequest) {
      cell.shift = "OFF";
      cell.paidRequest = true;
      cell.forceOffOnPaidReq = true;
      cell.autoMovedPaid = false;
      cell.noNight = false;
      cell.mOrOff = false;
      cell.isManual = true;
      cell.locked = true;

      // 別の「休(OFF)」の日（ただし前日が「明」ではない日）を探して「年(PAID)」をつける
      const candidates = [];
      for (let d2 = 1; d2 <= daysInMonth; d2++) {
        if (d2 === day) continue;
        const c2 = sched.cells[staffId][d2];
        if (!c2 || c2.shift !== "OFF" || c2.paidRequest) continue;
        const prevSh2 =
          d2 === 1
            ? Validator.getShiftAt(sched, staffId, 0)
            : sched.cells[staffId][d2 - 1]
            ? sched.cells[staffId][d2 - 1].shift
            : "OFF";
        if (prevSh2 === "M") continue; // 夜→明→休の「休」は除外
        candidates.push({ day: d2, locked: !!c2.locked });
      }
      candidates.sort((a, b) => (a.locked ? 1 : 0) - (b.locked ? 1 : 0));
      if (candidates.length > 0) {
        const targetDay = candidates[0].day;
        sched.cells[staffId][targetDay] = {
          shift: "PAID",
          locked: false,
          isManual: false,
          autoMovedPaid: true
        };
      }

      saveToStorage();
      renderAll();
      return;
    }

    cell.shift = shiftCode;
    cell.paidRequest = false;
    cell.forceOffOnPaidReq = false;
    cell.autoMovedPaid = false;
    cell.noNight = false;
    cell.mOrOff = false;
    cell.isManual = true;
    if (uiState.autoLockOnEdit) {
      cell.locked = true;
    }

    // 「夜」入力時に翌日「明」・翌々日「休」を100%セットで自動入力
    if (shiftCode === "N" && uiState.autoNightSet) {
      if (day + 1 <= daysInMonth) {
        sched.cells[staffId][day + 1] = {
          shift: "M",
          locked: uiState.autoLockOnEdit,
          isManual: true
        };
      }
      if (day + 2 <= daysInMonth) {
        sched.cells[staffId][day + 2] = {
          shift: "OFF",
          locked: uiState.autoLockOnEdit,
          isManual: true
        };
      }
    }

    saveToStorage();
    renderAll();
  }

  /**
   * セルの右クリックでロック（ピン留め）をトグル
   */
  function handleCellRightClick(e, staffId, day) {
    e.preventDefault();
    const sched = getCurrentSchedule();
    const cell = sched.cells[staffId][day];
    cell.locked = !cell.locked;
    if (!cell.locked && !cell.noNight && !cell.mOrOff) {
      cell.isManual = false;
    }
    saveToStorage();
    renderAll();
  }

  /**
   * 日付ヘッダークリックで祝日（休日扱い）をトグル（年末年始等の病院休診日対応）
   */
  function handleDayHeaderClick(day) {
    const sched = getCurrentSchedule();
    const dow = new Date(appData.currentYear, appData.currentMonth - 1, day).getDay();
    if (dow === 0 || dow === 6) {
      return; // 土日は常時休日
    }
    const idx = sched.holidays.indexOf(day);
    if (idx >= 0) {
      sched.holidays.splice(idx, 1);
    } else {
      sched.holidays.push(day);
      sched.holidays.sort((a, b) => a - b);
      // 休日になった日はパートを自動的に「休」(ロック)にする
      for (const st of appData.staffList) {
        if (st.employmentType === "part") {
          const cur = sched.cells[st.id][day];
          if (cur.shift !== "PAID") {
            sched.cells[st.id][day] = { shift: "OFF", locked: true };
          }
        }
      }
    }
    // 手動固定されていなければ週休数を自動更新
    if (!sched.isWeeklyOffManual) {
      const dc = HolidayUtils.getMonthDayCounts(
        appData.currentYear,
        appData.currentMonth,
        sched.holidays
      );
      sched.baseWeeklyOff = dc.holidayAndWeekendDays;
    }
    saveToStorage();
    renderAll();
  }

  /**
   * シフト自動作成を実行する
   */
  function runAutoGenerate() {
    const sched = getCurrentSchedule();
    const state = {
      year: appData.currentYear,
      month: appData.currentMonth,
      staffList: appData.staffList,
      schedule: sched
    };

    const result = Solver.generateSchedule(state, 150);
    if (result && result.tempSchedule) {
      appData.schedulesByMonth[getMonthKey(appData.currentYear, appData.currentMonth)] =
        result.tempSchedule;
      saveToStorage();
      renderAll();
    }
  }

  /**
   * ピン留め（ロック）以外のセルを初期状態にクリアする
   */
  function clearUnlockedCells() {
    if (!confirm("ピン留め（📌ロック）されていないマスをすべてクリアしますか？\n（パートの土日祝休み・ロック済みの希望休や年休は保持されます）")) {
      return;
    }
    const sched = getCurrentSchedule();
    const daysInMonth = new Date(appData.currentYear, appData.currentMonth, 0).getDate();

    for (const st of appData.staffList) {
      for (let d = 1; d <= daysInMonth; d++) {
        const isHol = HolidayUtils.isHolidayOrWeekend(
          appData.currentYear,
          appData.currentMonth,
          d,
          sched.holidays
        );
        const curCell = sched.cells[st.id][d] || {};
        if (st.employmentType === "part" && isHol && !curCell.paidRequest) {
          sched.cells[st.id][d] = { shift: "OFF", locked: true, noNight: false, mOrOff: false, isManual: false };
        } else if (curCell.paidRequest) {
          sched.cells[st.id][d] = {
            shift: curCell.forceOffOnPaidReq ? "OFF" : "PAID",
            locked: true,
            paidRequest: true,
            forceOffOnPaidReq: !!curCell.forceOffOnPaidReq,
            autoMovedPaid: false,
            noNight: false,
            mOrOff: false,
            isManual: true
          };
        } else if (curCell.noNight) {
          sched.cells[st.id][d] = { shift: "NO_N", locked: false, noNight: true, mOrOff: false, isManual: true };
        } else if (curCell.mOrOff) {
          sched.cells[st.id][d] = { shift: "M_OFF", locked: false, noNight: false, mOrOff: true, isManual: true };
        } else if (!curCell.locked || curCell.autoMovedPaid) {
          sched.cells[st.id][d] = { shift: "OFF", locked: false, noNight: false, mOrOff: false, isManual: false };
        }
      }
      applyPrevMonthCarryover(st.id);
    }

    saveToStorage();
    renderAll();
  }

  /**
   * すべてのロックを解除する（パート土日祝を除く）
   */
  function unlockAllCells() {
    if (!confirm("すべてのピン留め（📌ロック）および手入力強調・「夜勤以外」「明/休」指定を解除しますか？（パートの土日祝休みを除く）")) {
      return;
    }
    const sched = getCurrentSchedule();
    const daysInMonth = new Date(appData.currentYear, appData.currentMonth, 0).getDate();
    for (const st of appData.staffList) {
      for (let d = 1; d <= daysInMonth; d++) {
        const isHol = HolidayUtils.isHolidayOrWeekend(
          appData.currentYear,
          appData.currentMonth,
          d,
          sched.holidays
        );
        if (!(st.employmentType === "part" && isHol)) {
          sched.cells[st.id][d].locked = false;
          sched.cells[st.id][d].noNight = false;
          sched.cells[st.id][d].mOrOff = false;
          sched.cells[st.id][d].paidRequest = false;
          sched.cells[st.id][d].forceOffOnPaidReq = false;
          sched.cells[st.id][d].autoMovedPaid = false;
          sched.cells[st.id][d].isManual = false;
          if (sched.cells[st.id][d].shift === "NO_N" || sched.cells[st.id][d].shift === "M_OFF") {
            sched.cells[st.id][d].shift = "OFF";
          }
        }
      }
    }
    saveToStorage();
    renderAll();
  }

  /**
   * 画面全体の描画
   */
  function renderAll() {
    const sched = getCurrentSchedule();
    const state = {
      year: appData.currentYear,
      month: appData.currentMonth,
      staffList: appData.staffList,
      schedule: sched
    };
    const validation = Validator.validateSchedule(state);

    // 年月・週休数表示更新
    const baseWeeklyOff = Validator.getMonthBaseWeeklyOff(
      appData.currentYear,
      appData.currentMonth,
      sched
    );
    const dc = HolidayUtils.getMonthDayCounts(
      appData.currentYear,
      appData.currentMonth,
      sched.holidays
    );

    document.getElementById("month-display").textContent = `${appData.currentYear}年 ${appData.currentMonth}月`;
    document.getElementById("print-title").textContent = `ナースエイド勤務表（${appData.currentYear}年${appData.currentMonth}月 ／ 基準週休数：${baseWeeklyOff}日）`;

    const weeklyOffInput = document.getElementById("input-base-weekly-off");
    if (weeklyOffInput) {
      weeklyOffInput.value = baseWeeklyOff;
    }
    const weeklyOffInfo = document.getElementById("weekly-off-auto-info");
    if (weeklyOffInfo) {
      weeklyOffInfo.textContent = `(土日${dc.weekendDays}/土日祝${dc.holidayAndWeekendDays})`;
    }

    renderPalette();
    renderStatusPanel(validation);
    renderScheduleTable(state, validation);
  }

  /**
   * 入力パレットの描画
   */
  function renderPalette() {
    const container = document.getElementById("palette-buttons");
    container.innerHTML = "";

    const tools = [
      { code: "D", label: "日", desc: "日勤", cls: "shift-D" },
      { code: "N", label: "夜", desc: "夜勤(明・休セット)", cls: "shift-N" },
      { code: "M", label: "明", desc: "明け", cls: "shift-M" },
      { code: "OFF", label: "休", desc: "公休・希望休", cls: "shift-OFF" },
      { code: "PAID", label: "年", desc: "年休", cls: "shift-PAID" },
      { code: "TRAIN", label: "研", desc: "研修", cls: "shift-TRAIN" },
      { code: "NO_N", label: "夜外", desc: "夜勤以外(日・明・休可)", cls: "shift-NO_N" },
      { code: "M_OFF", label: "明/休", desc: "明または休(自動割当)", cls: "shift-M_OFF" },
      { code: "LOCK", label: "📌", desc: "ロック切替", cls: "shift-OFF" }
    ];

    for (const t of tools) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `palette-btn ${uiState.activeTool === t.code ? "active" : ""}`;
      btn.innerHTML = `<span class="palette-badge ${t.cls}">${t.label}</span><span>${t.desc}</span>`;
      btn.addEventListener("click", () => {
        uiState.activeTool = t.code;
        renderPalette();
      });
      container.appendChild(btn);
    }

    document.getElementById("chk-auto-lock").checked = uiState.autoLockOnEdit;
    document.getElementById("chk-auto-night-set").checked = uiState.autoNightSet;
  }

  /**
   * エラー・警告・ステータスバーの描画
   */
  function renderStatusPanel(validation) {
    const panel = document.getElementById("status-panel");
    panel.innerHTML = "";

    // 夜勤均等化状況サマリ計算
    const fullStaff = appData.staffList.filter((s) => s.employmentType === "full");
    const stdCounts = fullStaff
      .filter((s) => !s.hasPersonalNightLimit)
      .map((s) => `${s.name.split(" ")[0]}:${validation.staffStats[s.id].N}回`);
    const persCounts = fullStaff
      .filter((s) => s.hasPersonalNightLimit)
      .map(
        (s) =>
          `${s.name.split(" ")[0]}:${validation.staffStats[s.id].N}/${validation.staffStats[s.id].nightMax}回(個別)`
      );

    if (validation.errors.length === 0) {
      const okBox = document.createElement("div");
      okBox.className = "alert-box alert-success";
      okBox.innerHTML = `
        <div>
          <strong>✅ すべての必須ルール（夜→明→休100%セット・設定週休数の厳守・日勤/夜勤人数・パート3〜4名条件・連続日勤ルール・夜勤上限）を満たしています。</strong>
          <div style="font-size:11.5px; margin-top:2px;">
            【夜勤回数】通常枠(全員同数目標): ${stdCounts.join(" / ") || "なし"}
            ${persCounts.length > 0 ? ` ｜ 個人事情枠: ${persCounts.join(" / ")}` : ""}
          </div>
        </div>
      `;
      panel.appendChild(okBox);
    } else {
      const errBox = document.createElement("div");
      errBox.className = "alert-box alert-error";
      const itemsHtml = validation.errors
        .slice(0, 12)
        .map((e) => `<li class="alert-item">❌ ${e.message}</li>`)
        .join("");
      const moreText =
        validation.errors.length > 12 ? `<li>...他 ${validation.errors.length - 12} 件</li>` : "";
      errBox.innerHTML = `
        <div>
          <strong>⚠️ ルール違反が ${validation.errors.length} 件あります（赤枠のマスまたは日別合計を確認してください）</strong>
          <ul class="alert-list" style="margin-top:4px;">${itemsHtml}${moreText}</ul>
        </div>
      `;
      panel.appendChild(errBox);
    }

    if (validation.warnings.length > 0) {
      const warnBox = document.createElement("div");
      warnBox.className = "alert-box alert-warning";
      const itemsHtml = validation.warnings
        .slice(0, 10)
        .map((w) => `<li class="alert-item">ℹ️ ${w.message}</li>`)
        .join("");
      warnBox.innerHTML = `
        <div>
          <strong>許容範囲の注意パターン（3日勤→夜勤 / 2夜勤連続 など）: ${validation.warnings.length} 件</strong>
          <ul class="alert-list" style="margin-top:3px;">${itemsHtml}</ul>
        </div>
      `;
      panel.appendChild(warnBox);
    }
  }

  /**
   * 勤務表メインテーブルの描画
   */
  function renderScheduleTable(state, validation) {
    const { year, month, staffList, schedule } = state;
    const daysInMonth = new Date(year, month, 0).getDate();
    const customHolidays = schedule.holidays || [];

    const thead = document.getElementById("schedule-thead");
    const tbody = document.getElementById("schedule-tbody");
    const tfoot = document.getElementById("schedule-tfoot");

    // 1. ヘッダー構築
    let headHtml = `
      <tr>
        <th class="col-staff">スタッフ氏名</th>
        <th class="col-type">区分<br/>夜勤枠</th>
        <th class="col-prev" title="前々月末・前月末の勤務（夜・明を入れると当月1・2日に明・休が自動連動します）">前月末<br/><span style="font-size:9.5px;font-weight:normal;">前々/前日</span></th>
    `;

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
      const cls = isHol ? "is-holiday" : dow === 6 ? "is-sat" : "";
      headHtml += `
        <th class="col-day day-header ${cls}" data-day="${d}" title="クリックで祝日（休日扱い）のON/OFFを切り替えられます">
          <span class="day-num">${d}</span>
          <span class="day-dow">${HolidayUtils.DOW_LABELS[dow]}</span>
        </th>
      `;
    }

    headHtml += `
        <th class="col-stat">日</th>
        <th class="col-stat">夜</th>
        <th class="col-stat">明</th>
        <th class="col-stat">休</th>
        <th class="col-stat" style="width:42px;min-width:42px;" title="その月の目標週休数（直接編集可能）">週休</th>
        <th class="col-stat">年</th>
        <th class="col-stat">研</th>
        <th class="col-hours">時間</th>
      </tr>
    `;
    thead.innerHTML = headHtml;

    // 日付ヘッダークリックイベント
    thead.querySelectorAll(".day-header").forEach((th) => {
      th.addEventListener("click", () => {
        const d = Number(th.getAttribute("data-day"));
        handleDayHeaderClick(d);
      });
    });

    // 2. スタッフ行の構築
    tbody.innerHTML = "";
    for (const st of staffList) {
      const tr = document.createElement("tr");
      const stats = validation.staffStats[st.id];
      const isPart = st.employmentType === "part";
      const timeRangeText = isPart ? "8:30-14:00" : "8:30-17:20";

      const limitBadge = isPart
        ? `<span class="staff-meta">土日祝休</span>`
        : st.hasPersonalNightLimit
        ? `<span class="badge-limit" title="${st.note || "個人事情優先"}">個別:${stats.nightMax}回</span>`
        : `<span class="staff-meta">上限${stats.nightMax}回(均)</span>`;

      const prev2Val = (schedule.prevMonth[st.id] && schedule.prevMonth[st.id].prev2) || "OFF";
      const prev1Val = (schedule.prevMonth[st.id] && schedule.prevMonth[st.id].prev1) || "OFF";

      const buildPrevOptions = (selected) => {
        const opts = isPart ? ["D", "OFF"] : ["D", "N", "M", "OFF"];
        return opts
          .map((code) => {
            const lbl = Validator.SHIFT_TYPES[code].label;
            return `<option value="${code}" ${code === selected ? "selected" : ""}>${lbl}</option>`;
          })
          .join("");
      };

      let rowHtml = `
        <td class="col-staff">
          <div class="staff-name-wrap">
            <span class="staff-name" title="${st.name} (${st.note || timeRangeText})">${st.name}</span>
          </div>
          <span class="staff-meta">${st.note ? st.note : timeRangeText}</span>
        </td>
        <td class="col-type">
          <span class="badge-emp ${isPart ? "badge-part" : "badge-full"}">${isPart ? "パート" : "常勤"}</span>
          <div>${limitBadge}</div>
        </td>
        <td class="col-prev">
          <div style="display:flex; gap:2px; justify-content:center;">
            <select class="prev-select" data-staff="${st.id}" data-which="prev2" title="前々月末日の勤務">
              ${buildPrevOptions(prev2Val)}
            </select>
            <select class="prev-select" data-staff="${st.id}" data-which="prev1" title="前月末日の勤務">
              ${buildPrevOptions(prev1Val)}
            </select>
          </div>
        </td>
      `;

      for (let d = 1; d <= daysInMonth; d++) {
        const cell = schedule.cells[st.id][d];
        const sh = cell ? cell.shift : "OFF";
        const locked = cell ? !!cell.locked : false;
        const noNight = cell ? !!(cell.noNight || sh === "NO_N") : false;
        const mOrOff = cell ? !!(cell.mOrOff || sh === "M_OFF") : false;
        const paidRequest = cell ? !!cell.paidRequest : false;
        const autoMovedPaid = cell ? !!cell.autoMovedPaid : false;
        const isManual = cell ? !!cell.isManual : false;
        const label = Validator.SHIFT_TYPES[sh] ? Validator.SHIFT_TYPES[sh].label : "休";

        const dow = new Date(year, month - 1, d).getDay();
        const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
        const colBgClass = isHol ? "is-holiday" : dow === 6 ? "is-sat" : "";

        const mark = validation.cellMarks[`${st.id}_${d}`];
        const markClass = mark === "error" ? "cell-error" : mark === "warning" ? "cell-warning" : "";
        const manualClass = isManual ? "cell-manual" : "";

        const badgeClass = sh === "D" && isPart ? "shift-D-part" : `shift-${sh}`;
        const condNote = noNight
          ? "【夜勤以外指定: 自動作成で日・明・休を割当】"
          : mOrOff
          ? "【明/休指定: 自動作成で明・休を割当】"
          : paidRequest && sh === "OFF"
          ? "【年休指定→「休」に変更（別日に「年」を自動付与）】"
          : autoMovedPaid && sh === "PAID"
          ? "【振替年休: 「年」指定日が「休」になったためこの日に「年」を付与】"
          : "";
        const manualNote = isManual ? "【✍️手入力】" : "";

        let cornerIndicator = "";
        if (paidRequest && sh === "OFF") {
          cornerIndicator = '<span class="m-off-indicator" style="color:#be185d;background:#fce7f3;">年→休</span>';
        } else if (autoMovedPaid && sh === "PAID") {
          cornerIndicator = '<span class="m-off-indicator" style="color:#be185d;background:#fce7f3;">振年</span>';
        } else if (locked) {
          cornerIndicator = '<span class="lock-indicator">📌</span>';
        } else if (noNight && sh !== "NO_N") {
          cornerIndicator = '<span class="no-night-indicator">夜×</span>';
        } else if (mOrOff && sh !== "M_OFF") {
          cornerIndicator = '<span class="m-off-indicator">明/休</span>';
        }

        rowHtml += `
          <td class="col-day shift-cell ${colBgClass} ${manualClass} ${markClass}"
              data-staff="${st.id}" data-day="${d}"
              title="${st.name} / ${d}日: ${Validator.SHIFT_TYPES[sh].name} ${manualNote} ${condNote}（右クリックで📌ロック切替）">
            ${isManual ? '<span class="manual-corner" title="手入力マス"></span>' : ""}
            ${cornerIndicator}
            <span class="shift-badge ${badgeClass}">${label}</span>
          </td>
        `;
      }

      const nOver = !isPart && stats.N > stats.nightMax;
      const offMismatch = stats.OFF !== stats.targetOff;
      rowHtml += `
        <td class="col-stat"><strong>${stats.D}</strong></td>
        <td class="col-stat ${nOver ? "count-ng" : ""}"><strong>${stats.N}</strong></td>
        <td class="col-stat">${stats.M}</td>
        <td class="col-stat ${offMismatch ? "count-ng" : "count-ok"}" title="実際の「休」日数: ${stats.OFF}日 / 設定週休数: ${stats.targetOff}日（必須ルール）">${stats.OFF}</td>
        <td class="col-stat" style="width:42px;min-width:42px;">
          <input type="number" class="staff-off-input" min="0" max="31"
                 value="${stats.targetOff}" data-staff-off="${st.id}"
                 title="${st.name}さんの設定週休数を編集（現在:${stats.targetOff}日・必須ルール）" />
        </td>
        <td class="col-stat">${stats.PAID}</td>
        <td class="col-stat">${stats.TRAIN}</td>
        <td class="col-hours">${Exporter.formatHours(stats.totalMinutes)}</td>
      `;

      tr.innerHTML = rowHtml;
      tbody.appendChild(tr);
    }

    // スタッフ個人の週休数変更イベント登録
    tbody.querySelectorAll(".staff-off-input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const sid = inp.getAttribute("data-staff-off");
        const val = Math.max(0, Math.min(31, Number(inp.value)));
        if (!schedule.staffWeeklyOff) schedule.staffWeeklyOff = {};
        schedule.staffWeeklyOff[sid] = val;
        saveToStorage();
        renderAll();
      });
    });

    // セルの左クリック・右クリックイベント登録
    tbody.querySelectorAll(".shift-cell").forEach((td) => {
      const sid = td.getAttribute("data-staff");
      const day = Number(td.getAttribute("data-day"));
      td.addEventListener("click", () => handleCellClick(sid, day));
      td.addEventListener("contextmenu", (e) => handleCellRightClick(e, sid, day));
    });

    // 前月末セレクト変更イベント
    tbody.querySelectorAll(".prev-select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const sid = sel.getAttribute("data-staff");
        const which = sel.getAttribute("data-which");
        schedule.prevMonth[sid][which] = sel.value;
        applyPrevMonthCarryover(sid);
        saveToStorage();
        renderAll();
      });
    });

    // 3. 日別集計フッター構築
    let footHtml = "";

    // (1) 日勤合計行
    footHtml += `
      <tr class="summary-row row-divider">
        <th class="col-staff">【日勤 合計】</th>
        <td class="col-type" style="font-size:10px;">平2-3(パ3-4)<br/>休1-2名</td>
        <td class="col-prev">-</td>
    `;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = validation.dayStats[d];
      const cls = ds.dOk ? "count-ok" : "count-ng";
      footHtml += `<td class="${cls}" title="${d}日 目標:${ds.dTargetText}名 / 現在:常勤${ds.dFull}名+パート${ds.dPart}名">${ds.dTotal}</td>`;
    }
    footHtml += `<td colspan="8"></td></tr>`;

    // (2) うちパート内訳行
    footHtml += `
      <tr class="summary-row">
        <th class="col-staff" style="font-weight:normal; color:#475569;"> └ うちパート日勤</th>
        <td class="col-type" style="font-size:10px; color:#475569;">8:30-14:00</td>
        <td class="col-prev">-</td>
    `;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = validation.dayStats[d];
      footHtml += `<td style="color:#0f766e; font-weight:${ds.dPart > 0 ? "700" : "400"};">${ds.dPart > 0 ? ds.dPart : "-"}</td>`;
    }
    footHtml += `<td colspan="8"></td></tr>`;

    // (3) 夜勤合計行
    footHtml += `
      <tr class="summary-row">
        <th class="col-staff">【夜勤 合計】</th>
        <td class="col-type" style="font-size:10px;">平・休<br/>1〜2名</td>
        <td class="col-prev">-</td>
    `;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = validation.dayStats[d];
      const cls = ds.nOk ? "count-ok" : "count-ng";
      footHtml += `<td class="${cls}">${ds.nCount}</td>`;
    }
    footHtml += `<td colspan="8"></td></tr>`;

    // (4) 明け合計行
    footHtml += `
      <tr class="summary-row">
        <th class="col-staff" style="font-weight:normal; color:#475569;">【明け 合計】</th>
        <td class="col-type" style="font-size:10px; color:#475569;">0:00-9:00</td>
        <td class="col-prev">-</td>
    `;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = validation.dayStats[d];
      footHtml += `<td style="color:#3730a3;">${ds.mCount}</td>`;
    }
    footHtml += `<td colspan="8"></td></tr>`;

    tfoot.innerHTML = footHtml;
  }

  /**
   * スタッフ・個人事情設定モーダルの描画と制御
   */
  let modalDraftStaff = [];

  function openStaffModal() {
    modalDraftStaff = JSON.parse(JSON.stringify(appData.staffList));
    renderStaffModalTable();
    document.getElementById("staff-modal").classList.add("open");
  }

  function closeStaffModal() {
    document.getElementById("staff-modal").classList.remove("open");
  }

  function renderStaffModalTable() {
    const tbody = document.getElementById("modal-staff-tbody");
    tbody.innerHTML = "";

    modalDraftStaff.forEach((st, idx) => {
      const isPart = st.employmentType === "part";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="text-align:center; font-weight:bold;">${idx + 1}</td>
        <td>
          <input type="text" class="input-text" value="${st.name}" data-idx="${idx}" data-field="name" placeholder="氏名を入力" />
        </td>
        <td>
          <select class="input-select" data-idx="${idx}" data-field="employmentType">
            <option value="full" ${!isPart ? "selected" : ""}>常勤 (8:30-17:20)</option>
            <option value="part" ${isPart ? "selected" : ""}>パート (8:30-14:00・土日祝休)</option>
          </select>
        </td>
        <td>
          ${
            isPart
              ? `<span style="color:#64748b; font-size:12px;">夜勤なし（0回）</span>`
              : `
                <select class="input-select" data-idx="${idx}" data-field="hasPersonalNightLimit">
                  <option value="false" ${!st.hasPersonalNightLimit ? "selected" : ""}>通常（全員同数で均等・上限6回）</option>
                  <option value="true" ${st.hasPersonalNightLimit ? "selected" : ""}>★個人事情あり（回数を個別指定）</option>
                </select>
              `
          }
        </td>
        <td style="text-align:center;">
          ${
            isPart
              ? `-`
              : st.hasPersonalNightLimit
              ? `<input type="number" class="input-num" min="0" max="6" value="${st.personalNightMax ?? 3}" data-idx="${idx}" data-field="personalNightMax" /> 回`
              : `<input type="number" class="input-num" min="1" max="6" value="${st.nightShiftMax ?? 6}" data-idx="${idx}" data-field="nightShiftMax" /> 回`
          }
        </td>
        <td>
          <input type="text" class="input-text" value="${st.note || ""}" data-idx="${idx}" data-field="note" placeholder="例: 育児のため夜勤2回まで" />
        </td>
        <td style="text-align:center;">
          <button type="button" class="btn btn-sm btn-danger-outline" data-remove="${idx}">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // イベントバインド
    tbody.querySelectorAll("input, select").forEach((el) => {
      el.addEventListener("change", () => {
        const idx = Number(el.getAttribute("data-idx"));
        const field = el.getAttribute("data-field");
        if (field === "hasPersonalNightLimit") {
          modalDraftStaff[idx].hasPersonalNightLimit = el.value === "true";
          renderStaffModalTable();
        } else if (field === "employmentType") {
          modalDraftStaff[idx].employmentType = el.value;
          if (el.value === "part") {
            modalDraftStaff[idx].hasPersonalNightLimit = false;
            modalDraftStaff[idx].nightShiftMax = 0;
          } else {
            modalDraftStaff[idx].nightShiftMax = 6;
          }
          renderStaffModalTable();
        } else if (field === "personalNightMax" || field === "nightShiftMax") {
          modalDraftStaff[idx][field] = Math.max(0, Math.min(6, Number(el.value)));
        } else {
          modalDraftStaff[idx][field] = el.value;
        }
      });
    });

    tbody.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-remove"));
        if (modalDraftStaff.length <= 1) {
          alert("最低1名のスタッフが必要です。");
          return;
        }
        modalDraftStaff.splice(idx, 1);
        renderStaffModalTable();
      });
    });
  }

  function saveStaffModal() {
    appData.staffList = modalDraftStaff.map((s, i) => ({
      ...s,
      name: (s.name || "").trim() || `スタッフ${i + 1}`
    }));

    // パートの土日祝ロックを再適用
    const sched = getCurrentSchedule();
    const daysInMonth = new Date(appData.currentYear, appData.currentMonth, 0).getDate();
    for (const st of appData.staffList) {
      if (st.employmentType === "part") {
        for (let d = 1; d <= daysInMonth; d++) {
          const isHol = HolidayUtils.isHolidayOrWeekend(
            appData.currentYear,
            appData.currentMonth,
            d,
            sched.holidays
          );
          if (isHol) {
            sched.cells[st.id][d] = { shift: "OFF", locked: true };
          }
        }
      }
    }

    saveToStorage();
    closeStaffModal();
    renderAll();
  }

  /**
   * 外部共有・アクセス制限（パスコード／招待リンク認証＆GitHub Pages対応）の検証と制御
   */
  let PUBLIC_HOST_URL = "https://ryu21qq.github.io/nurse-aide-schedule/"; // GitHub Pages公開URL

  function encodeShareSnapshot() {
    try {
      const key = getMonthKey(appData.currentYear, appData.currentMonth);
      const minimal = {
        y: appData.currentYear,
        m: appData.currentMonth,
        a: appData.authConfig,
        st: appData.staffList,
        sc: appData.schedulesByMonth[key]
      };
      const json = JSON.stringify(minimal);
      return btoa(unescape(encodeURIComponent(json)));
    } catch (e) {
      return "";
    }
  }

  function decodeShareSnapshotFromHash() {
    try {
      const hash = window.location.hash || "";
      const match = hash.match(/[#&]s=([^&]+)/);
      if (!match || !match[1]) return false;
      const json = decodeURIComponent(escape(atob(match[1])));
      const minimal = JSON.parse(json);
      if (minimal && Array.isArray(minimal.st) && minimal.sc) {
        appData.currentYear = minimal.y || 2026;
        appData.currentMonth = minimal.m || 12;
        if (minimal.a) appData.authConfig = minimal.a;
        appData.staffList = minimal.st;
        const key = getMonthKey(appData.currentYear, appData.currentMonth);
        appData.schedulesByMonth[key] = minimal.sc;
        return true;
      }
    } catch (e) {
      console.warn("Failed to decode share snapshot:", e);
    }
    return false;
  }

  function getShareBaseUrl() {
    if (PUBLIC_HOST_URL) {
      return PUBLIC_HOST_URL;
    }
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      const host =
        window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
          ? "192.168.10.182" + (window.location.port ? ":" + window.location.port : "")
          : window.location.host;
      return `${window.location.protocol}//${host}${window.location.pathname}`;
    }
    return "http://192.168.10.182:8080/";
  }

  function verifyAccessAuth(forceShowLock = false) {
    ensureAuthConfig();
    const overlay = document.getElementById("auth-lock-overlay");
    if (!overlay) return;

    if (!appData.authConfig.enabled && !forceShowLock) {
      overlay.classList.remove("active");
      return;
    }

    // URLパラメータ ?invite=... によるワンクリック招待認証チェック
    try {
      const params = new URLSearchParams(window.location.search);
      const inviteParam = params.get("invite");
      if (inviteParam && inviteParam === appData.authConfig.inviteToken) {
        sessionStorage.setItem(AUTH_SESSION_KEY, appData.authConfig.inviteToken);
        overlay.classList.remove("active");
        return;
      }
    } catch (e) {}

    // 作成者本人のPC（file:// または localhost）から開いている場合は初回自動認証（ただし「今すぐロック画面を確認」押下時は表示）
    const isCreatorLocal =
      window.location.protocol === "file:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (!forceShowLock) {
      const savedToken = sessionStorage.getItem(AUTH_SESSION_KEY);
      if (
        savedToken === appData.authConfig.inviteToken ||
        savedToken === "pass_" + appData.authConfig.passcode
      ) {
        overlay.classList.remove("active");
        return;
      }
      if (isCreatorLocal) {
        sessionStorage.setItem(AUTH_SESSION_KEY, "pass_" + appData.authConfig.passcode);
        overlay.classList.remove("active");
        return;
      }
    }

    // 未認証の外部アクセスの場合はロック画面を表示
    document.getElementById("input-auth-passcode").value = "";
    document.getElementById("auth-error-msg").textContent = "";
    overlay.classList.add("active");
  }

  function handleAuthSubmit() {
    ensureAuthConfig();
    const inputVal = (document.getElementById("input-auth-passcode").value || "").trim();
    const errEl = document.getElementById("auth-error-msg");
    if (inputVal === appData.authConfig.passcode) {
      sessionStorage.setItem(AUTH_SESSION_KEY, "pass_" + appData.authConfig.passcode);
      document.getElementById("auth-lock-overlay").classList.remove("active");
      errEl.textContent = "";
    } else {
      errEl.textContent = "パスコード（合言葉）が正しくありません。";
    }
  }

  function openShareModal() {
    ensureAuthConfig();
    updateShareModalUI();
    document.getElementById("share-modal").classList.add("open");
  }

  function closeShareModal() {
    document.getElementById("share-modal").classList.remove("open");
  }

  function updateShareModalUI() {
    ensureAuthConfig();
    document.getElementById("chk-enable-auth").checked = !!appData.authConfig.enabled;
    document.getElementById("input-share-passcode").value = appData.authConfig.passcode;

    const baseUrl = getShareBaseUrl();
    const snap = encodeShareSnapshot();
    const hashPart = snap ? `#s=${snap}` : "";
    document.getElementById("input-share-normal-url").value = `${baseUrl}${hashPart}`;
    const sep = baseUrl.includes("?") ? "&" : "?";
    document.getElementById("input-share-invite-url").value = `${baseUrl}${sep}invite=${appData.authConfig.inviteToken}${hashPart}`;
  }

  function copyTextToClipboard(text, label) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        alert(`${label}をコピーしました。\n共有したい相手にのみ送信してください。`);
      });
    } else {
      prompt(`${label}をコピーしてください:`, text);
    }
  }

  /**
   * 初期化処理
   */
  function initApp() {
    const loadedFromHash = decodeShareSnapshotFromHash();
    const loaded = loadedFromHash ? true : loadFromStorage();
    ensureAuthConfig();
    if (!loaded) {
      appData.staffList = JSON.parse(JSON.stringify(DEFAULT_STAFF));
      getCurrentSchedule();
      // 初回起動時はすぐにサンプル勤務表が閲覧できるよう自動作成を実行
      runAutoGenerate();
    } else {
      if (loadedFromHash) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
        } catch (e) {}
      }
      renderAll();
    }

    verifyAccessAuth(false);

    // WebサーバーまたはGitHub Pages経由でアクセスしている場合は共有データと同期する
    if (
      !loadedFromHash &&
      (window.location.protocol === "http:" || window.location.protocol === "https:")
    ) {
      fetch("/api/data")
        .then((res) => (res.ok ? res.json() : fetch("./schedule_data.json").then((r2) => (r2.ok ? r2.json() : null))))
        .then((serverData) => {
          if (serverData && Array.isArray(serverData.staffList) && serverData.staffList.length > 0) {
            appData = serverData;
            ensureAuthConfig();
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
            } catch (e) {}
            verifyAccessAuth(false);
            renderAll();
          } else {
            saveToStorage();
          }
        })
        .catch(() => {});
    }

    // ヘッダーボタンイベント
    document.getElementById("btn-prev-month").addEventListener("click", () => {
      appData.currentMonth--;
      if (appData.currentMonth < 1) {
        appData.currentMonth = 12;
        appData.currentYear--;
      }
      saveToStorage();
      renderAll();
    });

    document.getElementById("btn-next-month").addEventListener("click", () => {
      appData.currentMonth++;
      if (appData.currentMonth > 12) {
        appData.currentMonth = 1;
        appData.currentYear++;
      }
      saveToStorage();
      renderAll();
    });

    // 週休数（月間基準）の手動変更イベント
    document.getElementById("input-base-weekly-off").addEventListener("change", (e) => {
      const sched = getCurrentSchedule();
      const val = Math.max(0, Math.min(31, Number(e.target.value)));
      sched.baseWeeklyOff = val;
      sched.isWeeklyOffManual = true;
      // 常勤スタッフの個別週休数も一括更新できるようリセット
      if (sched.staffWeeklyOff) {
        for (const st of appData.staffList) {
          if (st.employmentType === "full") {
            delete sched.staffWeeklyOff[st.id];
          }
        }
      }
      saveToStorage();
      renderAll();
    });

    // 週休数の自動算出リセットボタン
    document.getElementById("btn-auto-weekly-off").addEventListener("click", () => {
      const sched = getCurrentSchedule();
      const dc = HolidayUtils.getMonthDayCounts(
        appData.currentYear,
        appData.currentMonth,
        sched.holidays
      );
      sched.baseWeeklyOff = dc.holidayAndWeekendDays;
      sched.isWeeklyOffManual = false;
      sched.staffWeeklyOff = {};
      saveToStorage();
      renderAll();
    });

    document.getElementById("btn-auto-generate").addEventListener("click", () => {
      runAutoGenerate();
    });

    document.getElementById("btn-staff-modal").addEventListener("click", () => {
      openStaffModal();
    });

    // 共有・アクセス制限モーダル関連イベント
    document.getElementById("btn-share-modal").addEventListener("click", () => {
      openShareModal();
    });
    document.getElementById("btn-close-share-modal").addEventListener("click", closeShareModal);
    document.getElementById("btn-ok-share-modal").addEventListener("click", closeShareModal);

    document.getElementById("btn-auth-submit").addEventListener("click", handleAuthSubmit);
    document.getElementById("input-auth-passcode").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleAuthSubmit();
    });

    document.getElementById("chk-enable-auth").addEventListener("change", (e) => {
      ensureAuthConfig();
      appData.authConfig.enabled = e.target.checked;
      saveToStorage();
      updateShareModalUI();
    });

    document.getElementById("btn-save-share-settings").addEventListener("click", () => {
      ensureAuthConfig();
      const val = (document.getElementById("input-share-passcode").value || "").trim();
      if (!val) {
        alert("パスコード（合言葉）を1文字以上入力してください。");
        return;
      }
      appData.authConfig.passcode = val;
      sessionStorage.setItem(AUTH_SESSION_KEY, "pass_" + val);
      saveToStorage();
      updateShareModalUI();
      alert(`共有パスコードを「${val}」に保存しました。`);
    });

    document.getElementById("btn-copy-normal-url").addEventListener("click", () => {
      const url = document.getElementById("input-share-normal-url").value;
      copyTextToClipboard(
        url,
        `共有URL（合言葉: ${appData.authConfig.passcode}）`
      );
    });

    document.getElementById("btn-copy-invite-url").addEventListener("click", () => {
      const url = document.getElementById("input-share-invite-url").value;
      copyTextToClipboard(url, "ワンクリック招待リンク");
    });

    document.getElementById("btn-regen-invite-token").addEventListener("click", () => {
      if (!confirm("招待キーを再発行しますか？\n（これまでに共有した古い招待リンクは無効になります）")) {
        return;
      }
      ensureAuthConfig();
      appData.authConfig.inviteToken =
        "na_inv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
      saveToStorage();
      updateShareModalUI();
      alert("新しい招待リンクを発行しました。古い招待リンクは無効化されました。");
    });

    document.getElementById("btn-lock-now").addEventListener("click", () => {
      closeShareModal();
      sessionStorage.removeItem(AUTH_SESSION_KEY);
      verifyAccessAuth(true);
    });

    document.getElementById("btn-clear-unlocked").addEventListener("click", () => {
      clearUnlockedCells();
    });

    document.getElementById("btn-unlock-all").addEventListener("click", () => {
      unlockAllCells();
    });

    document.getElementById("btn-export-excel").addEventListener("click", () => {
      const sched = getCurrentSchedule();
      const state = {
        year: appData.currentYear,
        month: appData.currentMonth,
        staffList: appData.staffList,
        schedule: sched
      };
      const validation = Validator.validateSchedule(state);
      Exporter.exportToExcel(state, validation);
    });

    document.getElementById("btn-print").addEventListener("click", () => {
      window.print();
    });

    document.getElementById("btn-export-json").addEventListener("click", () => {
      Exporter.exportToJson(appData, appData.currentYear, appData.currentMonth);
    });

    document.getElementById("btn-import-json").addEventListener("click", () => {
      document.getElementById("file-import-json").click();
    });

    document.getElementById("file-import-json").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (parsed && Array.isArray(parsed.staffList)) {
            appData = parsed;
            saveToStorage();
            renderAll();
            alert("勤務表データを読み込みました。");
          } else {
            alert("正しい勤務表データファイルではありません。");
          }
        } catch (err) {
          alert("ファイルの読み込みに失敗しました。");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });

    // チェックボックスイベント
    document.getElementById("chk-auto-lock").addEventListener("change", (e) => {
      uiState.autoLockOnEdit = e.target.checked;
    });
    document.getElementById("chk-auto-night-set").addEventListener("change", (e) => {
      uiState.autoNightSet = e.target.checked;
    });

    // モーダル内イベント
    document.getElementById("btn-close-modal").addEventListener("click", closeStaffModal);
    document.getElementById("btn-cancel-modal").addEventListener("click", closeStaffModal);
    document.getElementById("btn-save-modal").addEventListener("click", saveStaffModal);
    document.getElementById("btn-add-staff").addEventListener("click", () => {
      modalDraftStaff.push({
        id: "st_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
        name: `新規スタッフ ${modalDraftStaff.length + 1}`,
        employmentType: "full",
        nightShiftMax: 6,
        hasPersonalNightLimit: false,
        personalNightMax: 6,
        note: ""
      });
      renderStaffModalTable();
    });
  }

  document.addEventListener("DOMContentLoaded", initApp);
})(window);
