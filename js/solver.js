/**
 * ナースエイド勤務表 自動作成ソルバー (solver.js)
 *
 * 遵守ルール:
 * 1. 「夜」→翌日「明」→翌々日「休」 100%セット（月跨ぎ引継ぎ含む）
 * 2. パートは土日祝100%休み、勤務は「日」(8:30-14:00)のみ
 * 3. 日勤人数: 平日2〜3名（パートを含む場合は必ず3名）、休日1〜2名
 * 4. 夜勤人数: 平日1〜2名、休日1〜2名
 * 5. 夜勤前の日勤連続: 0〜2日勤を基本、3日勤夜勤は許容、4日勤以上夜勤は不可
 * 6. 連続夜勤: 基本は連続させない、2夜勤連続(夜・明・休・夜)まで許容、3夜勤連続は不可
 * 7. 夜勤回数: 上限6回。個人の事情(個別設定)を最優先した上で、通常メンバー全員を同数に均等化
 */
(function (global) {
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  /**
   * 初期グリッドとロック状態を作成する
   */
  function buildInitialGrid(state) {
    const { year, month, staffList, schedule } = state;
    const daysInMonth = new Date(year, month, 0).getDate();
    const customHolidays = schedule.holidays || [];

    const grid = {};  // grid[staffId][day] = ShiftCode
    const fixed = {}; // fixed[staffId][day] = boolean

    for (const st of staffList) {
      grid[st.id] = {};
      fixed[st.id] = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const cell = schedule.cells && schedule.cells[st.id] && schedule.cells[st.id][d];
        const isPaidReq = Boolean(
          cell && (cell.paidRequest || (cell.shift === "PAID" && !cell.autoMovedPaid))
        );
        if (isPaidReq) {
          // 「年」が入力されたマスは「休」か「年」とするため、配置探索中は一旦「休(OFF)」で固定する
          // （これにより d-2 に「夜」が入って d が「夜→明→休」の「休」になることも許容し、その場合は別の休日に「年」を付与する）
          grid[st.id][d] = "OFF";
          fixed[st.id][d] = true;
        } else if (cell && cell.autoMovedPaid) {
          // 前回の自動振替でついた「年」は一旦クリアして再配置可能にする
          grid[st.id][d] = null;
          fixed[st.id][d] = false;
        } else if (
          cell &&
          cell.locked &&
          cell.shift !== "NO_N" &&
          !cell.noNight &&
          cell.shift !== "M_OFF" &&
          !cell.mOrOff
        ) {
          grid[st.id][d] = cell.shift;
          fixed[st.id][d] = true;
        } else {
          grid[st.id][d] = null;
          fixed[st.id][d] = false;
        }
      }

      // パートは土日祝をすべて「休」で固定（年休等がロックされている場合を除く）
      if (st.employmentType === "part") {
        for (let d = 1; d <= daysInMonth; d++) {
          const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
          if (isHol && !fixed[st.id][d]) {
            grid[st.id][d] = "OFF";
            fixed[st.id][d] = true;
          }
        }
      }

      // 前月末からの「夜→明→休」引継ぎ固定
      const prev1 = Validator.getShiftAt(schedule, st.id, 0);
      const prev2 = Validator.getShiftAt(schedule, st.id, -1);
      if (prev1 === "N") {
        if (1 <= daysInMonth) {
          grid[st.id][1] = "M";
          fixed[st.id][1] = true;
        }
        if (2 <= daysInMonth) {
          grid[st.id][2] = "OFF";
          fixed[st.id][2] = true;
        }
      } else if (prev1 === "M" || prev2 === "N") {
        if (1 <= daysInMonth) {
          grid[st.id][1] = "OFF";
          fixed[st.id][1] = true;
        }
      }
    }

    // 既にロックされている「夜」「明」の前後セットを固定
    for (const st of staffList) {
      for (let d = 1; d <= daysInMonth; d++) {
        if (fixed[st.id][d] && grid[st.id][d] === "N") {
          if (d + 1 <= daysInMonth && !fixed[st.id][d + 1]) {
            grid[st.id][d + 1] = "M";
            fixed[st.id][d + 1] = true;
          }
          if (d + 2 <= daysInMonth && !fixed[st.id][d + 2]) {
            grid[st.id][d + 2] = "OFF";
            fixed[st.id][d + 2] = true;
          }
        } else if (fixed[st.id][d] && grid[st.id][d] === "M") {
          if (d - 1 >= 1 && !fixed[st.id][d - 1]) {
            grid[st.id][d - 1] = "N";
            fixed[st.id][d - 1] = true;
          }
          if (d + 1 <= daysInMonth && !fixed[st.id][d + 1]) {
            grid[st.id][d + 1] = "OFF";
            fixed[st.id][d + 1] = true;
          }
        }
      }
    }

    return { grid, fixed, daysInMonth };
  }

  /**
   * スタッフ s が d 日に「夜」を配置可能かチェックする
   */
  function canPlaceNight(grid, fixed, schedule, staff, d, daysInMonth, allowConsecutiveNight) {
    if (staff.employmentType === "part") return false;
    const sid = staff.id;

    // 「夜勤以外(NO_N / noNight)」または「明/休(M_OFF / mOrOff)」が指定されている日は「夜」を配置不可
    const origCell = schedule.cells && schedule.cells[sid] && schedule.cells[sid][d];
    if (
      origCell &&
      (origCell.noNight ||
        origCell.shift === "NO_N" ||
        origCell.mOrOff ||
        origCell.shift === "M_OFF")
    ) {
      return false;
    }

    // 既に d が N で固定されている場合は true
    if (fixed[sid][d] && grid[sid][d] === "N") return true;

    // d, d+1, d+2 の空きチェック
    if (fixed[sid][d] && grid[sid][d] !== "N") return false;
    if (grid[sid][d] !== null && grid[sid][d] !== "N") return false;

    if (d + 1 <= daysInMonth) {
      if (fixed[sid][d + 1] && grid[sid][d + 1] !== "M") return false;
      if (grid[sid][d + 1] !== null && grid[sid][d + 1] !== "M") return false;
    }
    if (d + 2 <= daysInMonth) {
      if (fixed[sid][d + 2] && grid[sid][d + 2] !== "OFF") return false;
      if (grid[sid][d + 2] !== null && grid[sid][d + 2] !== "OFF") return false;
    }

    // 前後の N と被らないかチェック
    const getSh = (day) => {
      if (day <= 0) return Validator.getShiftAt(schedule, sid, day);
      if (day > daysInMonth) return null;
      return grid[sid][day];
    };

    // d-1, d-2 に N があれば不可（明・休と重なるため）
    if (getSh(d - 1) === "N" || getSh(d - 2) === "N") return false;
    // d+1, d+2 に N があれば不可
    if (getSh(d + 1) === "N" || getSh(d + 2) === "N") return false;

    // 連続夜勤チェック:
    // d-3 が N なら「2夜勤連続(N,M,OFF,N)」、さらに d-6 も N なら「3夜勤連続(不可)」
    // d+3 が N なら同様にチェック
    const nMinus6 = getSh(d - 6) === "N";
    const nMinus3 = getSh(d - 3) === "N";
    const nPlus3 = getSh(d + 3) === "N";
    const nPlus6 = getSh(d + 6) === "N";

    if (!allowConsecutiveNight) {
      // 基本は連続夜勤を避ける
      if (nMinus3 || nPlus3) return false;
    } else {
      // 許容モードでも3夜勤連続は絶対不可
      if (nMinus3 && nMinus6) return false;
      if (nMinus3 && nPlus3) return false;
      if (nPlus3 && nPlus6) return false;
    }

    // 夜勤前の固定日勤が4連勤以上になっていないかチェック
    let preD = 0;
    for (let k = 1; k <= 4; k++) {
      const sh = getSh(d - k);
      if (sh === "D" || sh === "TRAIN") preD++;
      else break;
    }
    if (preD >= 4) return false;

    return true;
  }

  /**
   * スタッフごとの目標夜勤回数を計算する（個人事情を最優先し、通常スタッフは全員同数にする）
   * ※週休数の厳守のため、日勤枠に入りきらない出勤日数を夜勤＋明け(1〜2名枠)で吸収できるよう最適目標回数を算出
   */
  function computeNightTargets(state, daysInMonth) {
    const { year, month, staffList, schedule } = state;
    const fullStaff = staffList.filter((s) => s.employmentType === "full");
    const partStaff = staffList.filter((s) => s.employmentType === "part");
    const personalStaff = fullStaff.filter((s) => s.hasPersonalNightLimit);
    const standardStaff = fullStaff.filter((s) => !s.hasPersonalNightLimit);

    const targets = {};
    const maxLimits = {};

    let personalSum = 0;
    for (const s of personalStaff) {
      const lim = Validator.getEffectiveNightMax(s);
      maxLimits[s.id] = lim;
      targets[s.id] = lim; // 個人事情で設定された回数を目標兼上限とする
      personalSum += lim;
    }

    for (const s of standardStaff) {
      maxLimits[s.id] = Validator.getEffectiveNightMax(s);
    }

    // 週休数を厳守するために必要なチーム全体の夜勤回数の下限を計算
    const dc = HolidayUtils.getMonthDayCounts(year, month, schedule ? schedule.holidays : []);

    function countPaidAndTrain(sid) {
      let c = 0;
      const sCells = schedule && schedule.cells && schedule.cells[sid];
      if (!sCells) return 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const cell = sCells[d];
        if (!cell) continue;
        if (cell.paidRequest || (cell.shift === "PAID" && !cell.autoMovedPaid)) c++;
        else if (cell.locked && cell.shift === "TRAIN") c++;
      }
      return c;
    }

    let partWorkNeeded = 0;
    for (const p of partStaff) {
      const tOff = Validator.getStaffTargetOff(year, month, schedule, p);
      partWorkNeeded += Math.max(0, daysInMonth - tOff - countPaidAndTrain(p.id));
    }

    let fullWorkNeeded = 0;
    for (const s of fullStaff) {
      const tOff = Validator.getStaffTargetOff(year, month, schedule, s);
      fullWorkNeeded += Math.max(0, daysInMonth - tOff - countPaidAndTrain(s.id));
    }

    // パートが入る平日は日勤上限が4名(3〜4名)になるため、その分だけ月間日勤最大枠が増える
    const partDaysWith4Cap = Math.min(dc.weekdays, partWorkNeeded);
    const maxMonthD = dc.weekdays * 3 + partDaysWith4Cap + dc.holidayAndWeekendDays * 2;
    const maxFullD = Math.max(0, maxMonthD - partWorkNeeded);
    // 夜勤1回につき約2日分(夜+明)の出勤日数を消化する（月末最終日の夜勤のみ1日分）
    const nightsForWorkBalance = Math.ceil((fullWorkNeeded - maxFullD + 1) / 2);
    const totalNightsNeeded = Math.max(daysInMonth, nightsForWorkBalance);

    const remainingNeeded = Math.max(0, totalNightsNeeded - personalSum);
    let uniformTarget = 5;
    if (standardStaff.length > 0) {
      uniformTarget = Math.min(6, Math.ceil(remainingNeeded / standardStaff.length));
      if (uniformTarget < 1 && daysInMonth > 0) uniformTarget = 1;
    }

    for (const s of standardStaff) {
      targets[s.id] = Math.min(maxLimits[s.id], uniformTarget);
    }

    return { targets, maxLimits, uniformTarget };
  }

  /**
   * 1回分の試行で夜勤ブロック [夜][明][休] を配置する
   */
  function assignNightShiftsTrial(state, baseGrid, baseFixed, daysInMonth, targets, maxLimits) {
    const { staffList, schedule } = state;
    const fullStaff = staffList.filter((s) => s.employmentType === "full");

    // ディープコピー
    const grid = {};
    const fixed = {};
    const nCounts = {};
    for (const st of staffList) {
      grid[st.id] = { ...baseGrid[st.id] };
      fixed[st.id] = { ...baseFixed[st.id] };
      nCounts[st.id] = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        if (grid[st.id][d] === "N") nCounts[st.id]++;
      }
    }

    const dayNCount = {};
    for (let d = 1; d <= daysInMonth; d++) {
      let c = 0;
      for (const st of fullStaff) {
        if (grid[st.id][d] === "N") c++;
      }
      dayNCount[d] = c;
    }

    function placeN(sid, d) {
      grid[sid][d] = "N";
      fixed[sid][d] = true;
      if (d + 1 <= daysInMonth) {
        grid[sid][d + 1] = "M";
        fixed[sid][d + 1] = true;
      }
      if (d + 2 <= daysInMonth) {
        grid[sid][d + 2] = "OFF";
        fixed[sid][d + 2] = true;
      }
      nCounts[sid]++;
      dayNCount[d]++;
    }

    // Step A: まず全日程(1..daysInMonth)に最低1名の「夜」を配置する
    const daysOrder = shuffle(Array.from({ length: daysInMonth }, (_, i) => i + 1));
    // ロックが多い日や月末・月初を優先しやすいため、候補者が少ない日順にソートしつつランダム性を入れる
    for (const d of daysOrder) {
      if (dayNCount[d] >= 1) continue;

      // まず「連続夜勤なし」かつ「目標回数未満」のスタッフを探す
      let candidates = shuffle(fullStaff).filter(
        (s) =>
          nCounts[s.id] < targets[s.id] &&
          canPlaceNight(grid, fixed, schedule, s, d, daysInMonth, false)
      );

      // いなければ「2夜勤連続許容」かつ「目標回数未満」
      if (candidates.length === 0) {
        candidates = shuffle(fullStaff).filter(
          (s) =>
            nCounts[s.id] < targets[s.id] &&
            canPlaceNight(grid, fixed, schedule, s, d, daysInMonth, true)
        );
      }

      // それでもいなければ「上限(maxLimits)未満」で連続夜勤なし → 2夜勤連続許容
      if (candidates.length === 0) {
        candidates = shuffle(fullStaff).filter(
          (s) =>
            nCounts[s.id] < maxLimits[s.id] &&
            canPlaceNight(grid, fixed, schedule, s, d, daysInMonth, false)
        );
      }
      if (candidates.length === 0) {
        candidates = shuffle(fullStaff).filter(
          (s) =>
            nCounts[s.id] < maxLimits[s.id] &&
            canPlaceNight(grid, fixed, schedule, s, d, daysInMonth, true)
        );
      }

      if (candidates.length > 0) {
        // 目標までの残り回数が多いスタッフを優先
        candidates.sort((a, b) => (targets[b.id] - nCounts[b.id]) - (targets[a.id] - nCounts[a.id]));
        placeN(candidates[0].id, d);
      }
    }

    // Step B: 全員が目標夜勤回数(targets[s.id])に揃うよう、まだ目標に達していないスタッフを
    // 夜勤が1名の日（上限2名なので2人目として入れる日）に追加配置する
    let progress = true;
    while (progress) {
      progress = false;
      const underTargetStaff = shuffle(fullStaff).filter((s) => nCounts[s.id] < targets[s.id]);
      underTargetStaff.sort((a, b) => nCounts[a.id] - nCounts[b.id]);

      for (const s of underTargetStaff) {
        if (nCounts[s.id] >= targets[s.id]) continue;

        // まだ夜勤が0名または1名の日を探す（0名の日があれば最優先）
        const availDays0 = shuffle(Array.from({ length: daysInMonth }, (_, i) => i + 1)).filter(
          (d) => dayNCount[d] === 0 && canPlaceNight(grid, fixed, schedule, s, d, daysInMonth, false)
        );
        const availDays1NoConsec = shuffle(Array.from({ length: daysInMonth }, (_, i) => i + 1)).filter(
          (d) => dayNCount[d] === 1 && canPlaceNight(grid, fixed, schedule, s, d, daysInMonth, false)
        );
        const availDays1Consec = shuffle(Array.from({ length: daysInMonth }, (_, i) => i + 1)).filter(
          (d) => dayNCount[d] === 1 && canPlaceNight(grid, fixed, schedule, s, d, daysInMonth, true)
        );

        const chosenDay =
          availDays0[0] || availDays1NoConsec[0] || availDays1Consec[0] || null;

        if (chosenDay !== null) {
          placeN(s.id, chosenDay);
          progress = true;
        }
      }
    }

    return { grid, fixed, nCounts, dayNCount };
  }

  /**
   * スタッフ s が d 日に「日」に入った場合、直後の「夜」に対して4連勤以上にならないか判定
   */
  function wouldCause4DayBeforeNight(grid, schedule, sid, d, daysInMonth) {
    const getSh = (day) => {
      if (day === d) return "D";
      if (day <= 0) return Validator.getShiftAt(schedule, sid, day);
      if (day > daysInMonth) return "OFF";
      return grid[sid][day] || "OFF";
    };

    // d の後ろ（d+1 .. d+4）に N がある場合、その N の直前の連続 D 数を数える
    for (let nDay = d + 1; nDay <= Math.min(daysInMonth, d + 4); nDay++) {
      if (getSh(nDay) === "N") {
        let streak = 0;
        for (let k = nDay - 1; k >= -1; k--) {
          const sh = getSh(k);
          if (sh === "D" || sh === "TRAIN") streak++;
          else break;
        }
        if (streak >= 4) return true;
      }
    }
    return false;
  }

  /**
   * スタッフ s が d 日に「日」に入った場合、直後の「夜」に対して3連勤になるか判定
   */
  function wouldCause3DayBeforeNight(grid, schedule, sid, d, daysInMonth) {
    const getSh = (day) => {
      if (day === d) return "D";
      if (day <= 0) return Validator.getShiftAt(schedule, sid, day);
      if (day > daysInMonth) return "OFF";
      return grid[sid][day] || "OFF";
    };

    for (let nDay = d + 1; nDay <= Math.min(daysInMonth, d + 3); nDay++) {
      if (getSh(nDay) === "N") {
        let streak = 0;
        for (let k = nDay - 1; k >= -1; k--) {
          const sh = getSh(k);
          if (sh === "D" || sh === "TRAIN") streak++;
          else break;
        }
        if (streak === 3) return true;
      }
    }
    return false;
  }

  /**
   * スタッフ s が d 日に「日」に入った場合の連続日勤数（「日」の連続日数）を計算
   */
  function getDayShiftStreakIfPlaced(grid, schedule, sid, d, daysInMonth) {
    const isD = (day) => {
      if (day === d) return true;
      const sh =
        day <= 0
          ? Validator.getShiftAt(schedule, sid, day)
          : day > daysInMonth
          ? "OFF"
          : grid[sid][day] || "OFF";
      return sh === "D";
    };

    let streak = 1;
    let cur = d - 1;
    while (cur >= -1 && isD(cur)) {
      streak++;
      cur--;
    }
    cur = d + 1;
    while (cur <= daysInMonth && isD(cur)) {
      streak++;
      cur++;
    }
    return streak;
  }

  /**
   * スタッフ s が d 日に「日」に入った場合、「連続日勤は4日勤まで＆4日勤の翌日は休」ルールに違反するか判定
   */
  function wouldViolateConsecutiveDayRule(grid, schedule, sid, d, daysInMonth) {
    // 5日勤以上になる場合は不可（4日勤の翌日が「日」になってしまうため）
    const dStreak = getDayShiftStreakIfPlaced(grid, schedule, sid, d, daysInMonth);
    if (dStreak >= 5) return true;

    // 4日勤になる場合、その4日勤の最終日の翌日が既に「夜」や「研」等で埋まっていたら不可（翌日は休または年が必須）
    if (dStreak === 4) {
      let endD = d;
      while (endD + 1 <= daysInMonth && grid[sid][endD + 1] === "D") {
        endD++;
      }
      if (endD + 1 <= daysInMonth) {
        const nextSh = grid[sid][endD + 1];
        if (nextSh !== null && nextSh !== "OFF" && nextSh !== "PAID") {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * スタッフ s が d 日に勤務した場合の連続勤務日数を計算
   */
  function getWorkStreakIfPlaced(grid, schedule, sid, d, daysInMonth) {
    const isW = (day) => {
      if (day === d) return true;
      const sh =
        day <= 0
          ? Validator.getShiftAt(schedule, sid, day)
          : day > daysInMonth
          ? "OFF"
          : grid[sid][day] || "OFF";
      return sh === "D" || sh === "N" || sh === "M" || sh === "TRAIN";
    };

    let streak = 1;
    let cur = d - 1;
    while (cur >= -1 && isW(cur)) {
      streak++;
      cur--;
    }
    cur = d + 1;
    while (cur <= daysInMonth && isW(cur)) {
      streak++;
      cur++;
    }
    return streak;
  }

  /**
   * 夜勤配置後のグリッドに対し、パートおよび常勤の「日」「休」を割り当てる
   */
  function assignDayShifts(state, grid, fixed, daysInMonth) {
    const { year, month, staffList, schedule } = state;
    const customHolidays = schedule.holidays || [];
    const fullStaff = staffList.filter((s) => s.employmentType === "full");
    const partStaff = staffList.filter((s) => s.employmentType === "part");

    // 「明/休(M_OFF / mOrOff)」が指定されているマスで、前日「夜」による「明(M)」にならなかったマスは「休(OFF)」で固定する
    for (const st of staffList) {
      for (let d = 1; d <= daysInMonth; d++) {
        const origCell = schedule.cells && schedule.cells[st.id] && schedule.cells[st.id][d];
        if (origCell && (origCell.mOrOff || origCell.shift === "M_OFF")) {
          if (grid[st.id][d] !== "M") {
            grid[st.id][d] = "OFF";
          }
          fixed[st.id][d] = true;
        }
      }
    }

    // スタッフごとの「年」入力日リスト(paidReqDaysMap)と、一時的な目標OFF合計数(週休数＋年休入力数)を算出
    const paidReqDaysMap = {};
    const targetOffMap = {};
    const neededAdditionalD = {};
    const dCounts = {};
    for (const st of staffList) {
      paidReqDaysMap[st.id] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const origCell = schedule.cells && schedule.cells[st.id] && schedule.cells[st.id][d];
        if (origCell && (origCell.paidRequest || (origCell.shift === "PAID" && !origCell.autoMovedPaid))) {
          paidReqDaysMap[st.id].push(d);
        }
      }
      // 探索中は「年」入力マスも一旦「OFF」になっているため、週休数＋年休入力数を目標OFF合計とする
      targetOffMap[st.id] =
        Validator.getStaffTargetOff(year, month, schedule, st) + paidReqDaysMap[st.id].length;
      dCounts[st.id] = 0;
      let offOrNull = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        if (grid[st.id][d] === "D") dCounts[st.id]++;
        if (grid[st.id][d] === "OFF" || grid[st.id][d] === null) offOrNull++;
      }
      neededAdditionalD[st.id] = Math.max(0, offOrNull - targetOffMap[st.id]);
    }

    // 日ごとに必要人数を満たすよう「日」を配置
    for (let d = 1; d <= daysInMonth; d++) {
      const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);

      // 既に固定されている D の人数を確認
      let fixedFullD = 0;
      let fixedPartD = 0;
      for (const st of fullStaff) {
        if (grid[st.id][d] === "D") fixedFullD++;
      }
      for (const st of partStaff) {
        if (grid[st.id][d] === "D") fixedPartD++;
      }

      // その日に D に入れる候補者（grid[id][d] === null）を抽出
      // 4日勤→夜勤 または 5連続日勤以上になるスタッフはハード制約として除外
      const availFull = shuffle(fullStaff).filter(
        (s) =>
          grid[s.id][d] === null &&
          !wouldCause4DayBeforeNight(grid, schedule, s.id, d, daysInMonth) &&
          !wouldViolateConsecutiveDayRule(grid, schedule, s.id, d, daysInMonth)
      );

      // 候補者を「4日勤にならない(基本3日勤まで)」「3日勤→夜勤にならない」「週休目標に対する必要日勤残数が多い」順にソート
      availFull.sort((a, b) => {
        const aD4 = getDayShiftStreakIfPlaced(grid, schedule, a.id, d, daysInMonth) >= 4 ? 1 : 0;
        const bD4 = getDayShiftStreakIfPlaced(grid, schedule, b.id, d, daysInMonth) >= 4 ? 1 : 0;
        if (aD4 !== bD4) return aD4 - bD4;

        const a3 = wouldCause3DayBeforeNight(grid, schedule, a.id, d, daysInMonth) ? 1 : 0;
        const b3 = wouldCause3DayBeforeNight(grid, schedule, b.id, d, daysInMonth) ? 1 : 0;
        if (a3 !== b3) return a3 - b3;

        return neededAdditionalD[b.id] - neededAdditionalD[a.id];
      });

      const availPart = shuffle(partStaff).filter(
        (s) =>
          !isHol &&
          grid[s.id][d] === null &&
          neededAdditionalD[s.id] > 0 &&
          !wouldViolateConsecutiveDayRule(grid, schedule, s.id, d, daysInMonth)
      );
      availPart.sort((a, b) => {
        const aD4 = getDayShiftStreakIfPlaced(grid, schedule, a.id, d, daysInMonth) >= 4 ? 1 : 0;
        const bD4 = getDayShiftStreakIfPlaced(grid, schedule, b.id, d, daysInMonth) >= 4 ? 1 : 0;
        if (aD4 !== bD4) return aD4 - bD4;
        return neededAdditionalD[b.id] - neededAdditionalD[a.id];
      });

      if (isHol) {
        // 休日日勤: 1〜2名（常勤のみ）
        const needMoreWorkCount = availFull.filter((s) => neededAdditionalD[s.id] > 0).length;
        const targetD = fixedFullD + needMoreWorkCount >= 2 && availFull.length >= 2 ? 2 : 1;
        let currentD = fixedFullD;
        for (const s of availFull) {
          if (currentD >= targetD) break;
          if (
            currentD >= 1 &&
            (neededAdditionalD[s.id] <= 0 ||
              getDayShiftStreakIfPlaced(grid, schedule, s.id, d, daysInMonth) >= 4 ||
              wouldCause3DayBeforeNight(grid, schedule, s.id, d, daysInMonth))
          ) {
            break;
          }
          grid[s.id][d] = "D";
          dCounts[s.id]++;
          neededAdditionalD[s.id]--;
          currentD++;
        }
      } else {
        // 平日日勤: 2〜3名（パートを含む場合は3〜4名！）
        const canUsePart =
          (fixedPartD > 0 || availPart.length > 0) &&
          fixedFullD + availFull.length + fixedPartD + availPart.length >= 3;

        if (canUsePart) {
          let curPart = fixedPartD;
          let curFull = fixedFullD;

          if (curPart === 0 && availPart.length > 0) {
            const p = availPart[0];
            grid[p.id][d] = "D";
            dCounts[p.id]++;
            neededAdditionalD[p.id]--;
            curPart++;
          }

          // まず最低3名（必要日勤残数が多ければ最大4名まで）常勤・パートで埋める
          const needMoreFull = availFull.filter((s) => neededAdditionalD[s.id] > 0).length;
          const targetTotalWithPart =
            curFull + needMoreFull + curPart >= 4 && needMoreFull >= 3 ? 4 : 3;

          for (const s of availFull) {
            if (curFull + curPart >= targetTotalWithPart) break;
            if (curFull + curPart >= 3 && neededAdditionalD[s.id] <= 0) break;
            grid[s.id][d] = "D";
            dCounts[s.id]++;
            neededAdditionalD[s.id]--;
            curFull++;
          }

          for (let i = 1; i < availPart.length; i++) {
            if (curFull + curPart >= 4) break;
            if (curFull + curPart >= 3 && neededAdditionalD[availPart[i].id] <= 0) break;
            const p = availPart[i];
            grid[p.id][d] = "D";
            dCounts[p.id]++;
            neededAdditionalD[p.id]--;
            curPart++;
          }
        } else {
          // パートを含まない場合は常勤のみで2〜3名（週休数の調整のため余裕があれば3名まで可）
          let curFull = fixedFullD;
          const needMoreCount = availFull.filter((s) => neededAdditionalD[s.id] > 0).length;
          const targetFull = fixedFullD + needMoreCount >= 3 ? 3 : 2;
          for (const s of availFull) {
            if (curFull >= targetFull) break;
            if (curFull >= 2 && neededAdditionalD[s.id] <= 0) break;
            grid[s.id][d] = "D";
            dCounts[s.id]++;
            neededAdditionalD[s.id]--;
            curFull++;
          }
        }
      }

      // 残りの null セルはすべて「休」(OFF)にする
      for (const st of staffList) {
        if (grid[st.id][d] === null) {
          grid[st.id][d] = "OFF";
        }
      }
    }

    // 局所探索による改善パス（週休数の達成・3日勤→夜の解消）
    repairAndBalanceDayShifts(state, grid, fixed, daysInMonth, targetOffMap);

    // 「年」入力マスの最終確定（「休」になった場合は別の休日に「年」を付与）
    assignPaidFromRequests(state, grid, daysInMonth, paidReqDaysMap);
  }

  /**
   * 「年」が入力された箇所について、「休」または「年」とし、
   * 「休」にした場合（夜→明→休の「休」になった場合や手動で「休」に変えた場合）は別の休日に「年」をつける
   */
  function assignPaidFromRequests(state, grid, daysInMonth, paidReqDaysMap) {
    const { staffList, schedule } = state;

    for (const st of staffList) {
      const reqDays = paidReqDaysMap[st.id] || [];
      if (reqDays.length === 0) continue;

      let movedCount = 0;
      for (const d of reqDays) {
        const prevSh = d === 1 ? Validator.getShiftAt(schedule, st.id, 0) : grid[st.id][d - 1];
        const origCell = schedule.cells && schedule.cells[st.id] && schedule.cells[st.id][d];
        const forceOff = Boolean(origCell && origCell.forceOffOnPaidReq);

        // 前日が「明」（＝夜→明→休の100%セットで「休」必須）または手動で「休」指定された場合は「休」のままにし、別日に「年」を振る
        if (prevSh === "M" || forceOff) {
          grid[st.id][d] = "OFF";
          movedCount++;
        } else {
          grid[st.id][d] = "PAID";
        }
      }

      if (movedCount > 0) {
        // 別の「休(OFF)」の日（ただし前日が「明」ではない日）を探して「年(PAID)」をつける
        const candidateDays = [];
        for (let d2 = 1; d2 <= daysInMonth; d2++) {
          if (reqDays.includes(d2)) continue;
          if (grid[st.id][d2] !== "OFF") continue;
          const prevSh2 = d2 === 1 ? Validator.getShiftAt(schedule, st.id, 0) : grid[st.id][d2 - 1];
          if (prevSh2 === "M") continue; // 夜→明→休の「休」は変更不可

          const orig2 = schedule.cells && schedule.cells[st.id] && schedule.cells[st.id][d2];
          const isLockedOff = Boolean(orig2 && orig2.locked);
          candidateDays.push({ day: d2, isLockedOff });
        }

        // ロックされていない「休」を優先して「年」に変更
        candidateDays.sort((a, b) => (a.isLockedOff ? 1 : 0) - (b.isLockedOff ? 1 : 0));

        for (let i = 0; i < Math.min(movedCount, candidateDays.length); i++) {
          grid[st.id][candidateDays[i].day] = "PAID";
        }
      }
    }
  }

  /**
   * 週休数(targetOffMap)への一致調整および同一日内スワップによる3日勤→夜勤の解消
   */
  function repairAndBalanceDayShifts(state, grid, fixed, daysInMonth, targetOffMap) {
    const { year, month, staffList, schedule } = state;
    const customHolidays = schedule.holidays || [];
    const fullStaff = staffList.filter((s) => s.employmentType === "full");

    function countStaffOff(sid) {
      let c = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        if (grid[sid][d] === "OFF") c++;
      }
      return c;
    }

    function countDayD(d) {
      let fullD = 0;
      let partD = 0;
      for (const st of staffList) {
        if (grid[st.id][d] === "D") {
          if (st.employmentType === "part") partD++;
          else fullD++;
        }
      }
      return { fullD, partD, totalD: fullD + partD };
    }

    // Step 0: パートスタッフの「休」数が目標週休数(targetOffMap)とズレている場合の調整
    const partStaff = staffList.filter((s) => s.employmentType === "part");
    for (const p of partStaff) {
      let curOff = countStaffOff(p.id);
      const targetOff = targetOffMap[p.id];
      if (curOff > targetOff) {
        for (let d = 1; d <= daysInMonth && curOff > targetOff; d++) {
          const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
          if (isHol || grid[p.id][d] !== "OFF" || fixed[p.id][d]) continue;
          if (wouldViolateConsecutiveDayRule(grid, schedule, p.id, d, daysInMonth)) continue;
          const { totalD } = countDayD(d);
          // パートを含む日の日勤は3〜4名のため、現在2名または3名ならパートを追加して3名または4名にできる
          if (totalD === 2 || totalD === 3) {
            grid[p.id][d] = "D";
            curOff--;
          }
        }
      } else if (curOff < targetOff) {
        for (let d = 1; d <= daysInMonth && curOff < targetOff; d++) {
          if (grid[p.id][d] !== "D" || fixed[p.id][d]) continue;
          const { fullD, partD } = countDayD(d);
          if (partD === 1 && fullD >= 2 && fullD <= 3) {
            grid[p.id][d] = "OFF";
            curOff++;
          } else if (partD >= 2 && fullD + partD - 1 >= 3 && fullD + partD - 1 <= 4) {
            grid[p.id][d] = "OFF";
            curOff++;
          }
        }
      }
    }

    // Step 1: 各常勤スタッフの「休」数が目標週休数(targetOffMap)とズレている場合、日別人数範囲内で増減調整
    for (const s of fullStaff) {
      let curOff = countStaffOff(s.id);
      const targetOff = targetOffMap[s.id];

      // 「休」が多すぎる場合 → 人数上限に空きがある日に「日」を追加して「休」を減らす
      if (curOff > targetOff) {
        // 1st pass: 4日勤(基本は3日勤まで)・3日勤→夜を避けて追加
        for (let d = 1; d <= daysInMonth && curOff > targetOff; d++) {
          if (grid[s.id][d] !== "OFF" || fixed[s.id][d]) continue;
          if (wouldCause4DayBeforeNight(grid, schedule, s.id, d, daysInMonth)) continue;
          if (wouldViolateConsecutiveDayRule(grid, schedule, s.id, d, daysInMonth)) continue;
          if (getDayShiftStreakIfPlaced(grid, schedule, s.id, d, daysInMonth) >= 4) continue;
          if (wouldCause3DayBeforeNight(grid, schedule, s.id, d, daysInMonth)) continue;

          const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
          const { partD, totalD } = countDayD(d);
          const maxD = isHol ? 2 : partD > 0 ? 4 : 3;
          if (totalD < maxD) {
            grid[s.id][d] = "D";
            curOff--;
          }
        }
        // 2nd pass: 4日勤(翌日休)・3日勤→夜は許容して追加（5日勤以上・4日勤→夜は不可）
        for (let d = 1; d <= daysInMonth && curOff > targetOff; d++) {
          if (grid[s.id][d] !== "OFF" || fixed[s.id][d]) continue;
          if (wouldCause4DayBeforeNight(grid, schedule, s.id, d, daysInMonth)) continue;
          if (wouldViolateConsecutiveDayRule(grid, schedule, s.id, d, daysInMonth)) continue;

          const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
          const { partD, totalD } = countDayD(d);
          const maxD = isHol ? 2 : partD > 0 ? 4 : 3;
          if (totalD < maxD) {
            grid[s.id][d] = "D";
            curOff--;
          }
        }
      }
      // 「休」が少なすぎる場合 → 人数下限に余裕がある日の「日」を「休」に変えて「休」を増やす
      else if (curOff < targetOff) {
        for (let d = 1; d <= daysInMonth && curOff < targetOff; d++) {
          if (grid[s.id][d] !== "D" || fixed[s.id][d]) continue;
          const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
          const { partD, totalD } = countDayD(d);
          // パートがいる平日は3〜4名なので下限3名、パートなしの平日は下限2名、休日は下限1名
          const minD = isHol ? 1 : partD > 0 ? 3 : 2;
          if (totalD > minD) {
            grid[s.id][d] = "OFF";
            curOff++;
          }
        }
      }
    }

    // Step 1.5: 2ステップ連鎖調整（まだ週休数がズレているスタッフがいる場合、別スタッフを経由して空いている日へシフト移動）
    for (const s of fullStaff) {
      let curOff = countStaffOff(s.id);
      const targetOff = targetOffMap[s.id];

      if (curOff > targetOff) {
        for (let d1 = 1; d1 <= daysInMonth && curOff > targetOff; d1++) {
          if (grid[s.id][d1] !== "OFF" || fixed[s.id][d1]) continue;
          if (wouldCause4DayBeforeNight(grid, schedule, s.id, d1, daysInMonth)) continue;
          if (wouldViolateConsecutiveDayRule(grid, schedule, s.id, d1, daysInMonth)) continue;

          // d1 に D で入っている他の常勤スタッフ mid を探す
          let moved = false;
          for (const mid of fullStaff) {
            if (mid.id === s.id || grid[mid.id][d1] !== "D" || fixed[mid.id][d1]) continue;

            // mid が別の日 d2（上限に空きがある日）で OFF -> D にできるか探す
            for (let d2 = 1; d2 <= daysInMonth; d2++) {
              if (d2 === d1 || grid[mid.id][d2] !== "OFF" || fixed[mid.id][d2]) continue;
              const isHol2 = HolidayUtils.isHolidayOrWeekend(year, month, d2, customHolidays);
              const { partD: partD2, totalD: totalD2 } = countDayD(d2);
              const maxD2 = isHol2 ? 2 : partD2 > 0 ? 4 : 3;
              if (totalD2 >= maxD2) continue;

              // d1 で mid を OFF にした上で d2 で mid が 4日勤→夜 または 連続日勤ルール違反にならないか確認
              grid[mid.id][d1] = "OFF";
              const bad4 =
                wouldCause4DayBeforeNight(grid, schedule, mid.id, d2, daysInMonth) ||
                wouldViolateConsecutiveDayRule(grid, schedule, mid.id, d2, daysInMonth);
              if (!bad4) {
                grid[s.id][d1] = "D";
                grid[mid.id][d2] = "D";
                curOff--;
                moved = true;
                break;
              } else {
                grid[mid.id][d1] = "D";
              }
            }
            if (moved) break;
          }
        }
      } else if (curOff < targetOff) {
        for (let d1 = 1; d1 <= daysInMonth && curOff < targetOff; d1++) {
          if (grid[s.id][d1] !== "D" || fixed[s.id][d1]) continue;

          let moved = false;
          for (const mid of fullStaff) {
            if (mid.id === s.id || grid[mid.id][d1] !== "OFF" || fixed[mid.id][d1]) continue;
            if (wouldCause4DayBeforeNight(grid, schedule, mid.id, d1, daysInMonth)) continue;
            if (wouldViolateConsecutiveDayRule(grid, schedule, mid.id, d1, daysInMonth)) continue;

            // mid が別の日 d2（下限に余裕がある日）で D -> OFF にできるか探す
            for (let d2 = 1; d2 <= daysInMonth; d2++) {
              if (d2 === d1 || grid[mid.id][d2] !== "D" || fixed[mid.id][d2]) continue;
              const isHol2 = HolidayUtils.isHolidayOrWeekend(year, month, d2, customHolidays);
              const { partD: partD2, totalD: totalD2 } = countDayD(d2);
              const minD2 = isHol2 ? 1 : partD2 > 0 ? 3 : 2;
              if (totalD2 > minD2) {
                grid[s.id][d1] = "OFF";
                grid[mid.id][d1] = "D";
                grid[mid.id][d2] = "OFF";
                curOff++;
                moved = true;
                break;
              }
            }
            if (moved) break;
          }
        }
      }
    }

    if (fullStaff.length < 2) return;

    // 補助: スタッフ sid の現在の「4日勤」「3日勤→夜」等のペナルティ計算
    function staffPatternPenalty(sid) {
      let pen = 0;
      const getSh = (day) =>
        day <= 0
          ? Validator.getShiftAt(schedule, sid, day)
          : day > daysInMonth
          ? "OFF"
          : grid[sid][day];

      let dStreak = 0;
      for (let d = -1; d <= daysInMonth; d++) {
        const sh = getSh(d);
        if (sh === "D") {
          dStreak++;
          if (d >= 1 && dStreak === 4) {
            const nextSh = d + 1 <= daysInMonth ? getSh(d + 1) : "OFF";
            if (nextSh !== "OFF" && nextSh !== "PAID") {
              pen += 5000; // 4日勤の翌日が休でない場合は不可
            } else {
              pen += 120; // 4日勤(翌日休)は許容範囲だが基本3日勤までのため軽いペナルティ
            }
          } else if (d >= 1 && dStreak >= 5) {
            pen += 5000;
          }
        } else {
          dStreak = 0;
        }

        if (d >= 1 && sh === "N") {
          let preD = 0;
          for (let k = d - 1; k >= -1; k--) {
            const psh = getSh(k);
            if (psh === "D" || psh === "TRAIN") preD++;
            else break;
          }
          if (preD >= 4) pen += 5000;
          else if (preD === 3) pen += 100;
        }
      }
      return pen;
    }

    // Step 2: 同一日内での「日」⇔「休」スワップにより週休目標への一致と3日勤→夜の解消を行う
    for (let pass = 0; pass < 3; pass++) {
      for (let d = 1; d <= daysInMonth; d++) {
        const workingFull = fullStaff.filter((s) => grid[s.id][d] === "D" && !fixed[s.id][d]);
        const offFull = fullStaff.filter((s) => grid[s.id][d] === "OFF" && !fixed[s.id][d]);

        for (const wStaff of workingFull) {
          for (const oStaff of offFull) {
            if (grid[wStaff.id][d] !== "D" || grid[oStaff.id][d] !== "OFF") continue;

            const wOff = countStaffOff(wStaff.id);
            const oOff = countStaffOff(oStaff.id);
            const wTarget = targetOffMap[wStaff.id];
            const oTarget = targetOffMap[oStaff.id];

            const beforePen =
              staffPatternPenalty(wStaff.id) +
              staffPatternPenalty(oStaff.id) +
              Math.abs(wOff - wTarget) * 40 +
              Math.abs(oOff - oTarget) * 40;

            // 仮スワップ (wStaff: D->OFF で休+1, oStaff: OFF->D で休-1)
            grid[wStaff.id][d] = "OFF";
            grid[oStaff.id][d] = "D";

            const afterPen =
              staffPatternPenalty(wStaff.id) +
              staffPatternPenalty(oStaff.id) +
              Math.abs(wOff + 1 - wTarget) * 40 +
              Math.abs(oOff - 1 - oTarget) * 40;

            if (afterPen < beforePen) {
              break;
            } else {
              grid[wStaff.id][d] = "D";
              grid[oStaff.id][d] = "OFF";
            }
          }
        }
      }
    }
  }

  /**
   * 作成されたスケジュールを評価してペナルティスコアを算出する（低いほど良い）
   */
  function evaluateCandidate(state, grid, daysInMonth, targets) {
    const tempSchedule = {
      ...state.schedule,
      cells: {}
    };
    for (const st of state.staffList) {
      tempSchedule.cells[st.id] = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const origCell =
          state.schedule.cells &&
          state.schedule.cells[st.id] &&
          state.schedule.cells[st.id][d];
        const isNoNight = origCell ? !!(origCell.noNight || origCell.shift === "NO_N") : false;
        const isMOrOff = origCell ? !!(origCell.mOrOff || origCell.shift === "M_OFF") : false;
        const isPaidReq = Boolean(
          origCell && (origCell.paidRequest || (origCell.shift === "PAID" && !origCell.autoMovedPaid))
        );
        const forceOffOnPaidReq = origCell ? !!origCell.forceOffOnPaidReq : false;
        const autoMovedPaid = grid[st.id][d] === "PAID" && !isPaidReq;
        const isManual = origCell && !origCell.autoMovedPaid ? !!origCell.isManual : false;
        tempSchedule.cells[st.id][d] = {
          shift: grid[st.id][d],
          locked: origCell && !isNoNight && !isMOrOff && !origCell.autoMovedPaid ? !!origCell.locked : false,
          noNight: isNoNight,
          mOrOff: isMOrOff,
          paidRequest: isPaidReq,
          forceOffOnPaidReq,
          autoMovedPaid,
          isManual
        };
      }
    }

    const res = Validator.validateSchedule({
      ...state,
      schedule: tempSchedule
    });

    // ハードエラーは1件あたり +10000点
    let score = res.errors.length * 10000;
    // 許容警告（3日勤→夜、2夜勤連続など）は1件あたり +120点
    score += res.warnings.length * 120;

    // 目標夜勤回数および目標週休数(targetOff)とのズレにペナルティ
    const fullStaff = state.staffList.filter((s) => s.employmentType === "full");
    for (const s of fullStaff) {
      const actualN = res.staffStats[s.id].N;
      const diff = Math.abs(actualN - targets[s.id]);
      if (s.hasPersonalNightLimit) {
        score += diff * 800; // 個人事情の優先度を高く設定
      } else {
        score += diff * 500; // 全員均等化
      }

      const offDiff = Math.abs(res.staffStats[s.id].OFF - res.staffStats[s.id].targetOff);
      score += offDiff * 200;
    }

    // 常勤間の公休数のばらつきに軽いペナルティ
    if (fullStaff.length >= 2) {
      const offCounts = fullStaff.map((s) => res.staffStats[s.id].OFF + res.staffStats[s.id].PAID);
      const maxOff = Math.max(...offCounts);
      const minOff = Math.min(...offCounts);
      score += (maxOff - minOff) * 25;
    }

    return { score, tempSchedule, validation: res };
  }

  /**
   * マルチスタート最適化により最良のシフト表を自動生成する
   */
  function generateSchedule(state, iterations = 120) {
    const { grid: baseGrid, fixed: baseFixed, daysInMonth } = buildInitialGrid(state);
    const { targets, maxLimits } = computeNightTargets(state, daysInMonth);

    let bestResult = null;

    for (let iter = 0; iter < iterations; iter++) {
      const trial = assignNightShiftsTrial(
        state,
        baseGrid,
        baseFixed,
        daysInMonth,
        targets,
        maxLimits
      );

      assignDayShifts(state, trial.grid, trial.fixed, daysInMonth);

      const evaluated = evaluateCandidate(state, trial.grid, daysInMonth, targets);
      if (!bestResult || evaluated.score < bestResult.score) {
        bestResult = evaluated;
        if (bestResult.score === 0) break; // 完全解が見つかったら即時終了
      }
    }

    return bestResult;
  }

  global.Solver = {
    generateSchedule,
    computeNightTargets
  };
})(window);
