/**
 * Excel出力・CSV出力・JSONバックアップ機能 (export.js)
 */
(function (global) {
  function formatHours(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
  }

  /**
   * Excelで色・罫線付きで直接開ける .xls (HTML形式) ファイルを出力する
   */
  function exportToExcel(state, validation) {
    const { year, month, staffList, schedule } = state;
    const daysInMonth = new Date(year, month, 0).getDate();
    const customHolidays = schedule.holidays || [];

    const shiftColors = {
      D: "#eff6ff",
      N: "#312e81",
      M: "#e0e7ff",
      OFF: "#f1f5f9",
      PAID: "#fce7f3",
      TRAIN: "#fef3c7"
    };
    const shiftTextColors = {
      D: "#1d4ed8",
      N: "#ffffff",
      M: "#3730a3",
      OFF: "#64748b",
      PAID: "#be185d",
      TRAIN: "#b45309"
    };

    const baseWeeklyOff = Validator.getMonthBaseWeeklyOff(year, month, schedule);

    let html = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:excel"
            xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="UTF-8">
        <style>
          table { border-collapse: collapse; font-family: "Meiryo", sans-serif; font-size: 10pt; }
          th, td { border: 1px solid #94a3b8; text-align: center; vertical-align: middle; padding: 3px 4px; }
          .title { font-size: 14pt; font-weight: bold; text-align: left; border: none; }
          .subtitle { font-size: 9pt; color: #475569; text-align: left; border: none; }
        </style>
      </head>
      <body>
        <table>
          <tr>
            <td colspan="${daysInMonth + 11}" class="title">ナースエイド勤務表（${year}年${month}月 ／ 基準週休数：${baseWeeklyOff}日）</td>
          </tr>
          <tr>
            <td colspan="${daysInMonth + 11}" class="subtitle">
              【勤務時間】日(常勤): 8:30-17:20 / 日(パート): 8:30-14:00 / 夜: 16:30-23:59 / 明: 00:00-9:00 / 休・年・研: 終日
            </td>
          </tr>
          <tr>
            <th style="background:#f1f5f9; width:120px;">氏名</th>
            <th style="background:#f1f5f9; width:55px;">区分</th>
            <th style="background:#f1f5f9; width:55px;">夜上限</th>
    `;

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      const isHol = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
      const bg = isHol ? "#fef2f2" : dow === 6 ? "#eff6ff" : "#f8fafc";
      const fg = isHol ? "#dc2626" : dow === 6 ? "#1d4ed8" : "#1e293b";
      html += `<th style="background:${bg}; color:${fg}; width:28px;">${d}<br/>${HolidayUtils.DOW_LABELS[dow]}</th>`;
    }

    html += `
            <th style="background:#f1f5f9;">日</th>
            <th style="background:#f1f5f9;">夜</th>
            <th style="background:#f1f5f9;">明</th>
            <th style="background:#f1f5f9;">休</th>
            <th style="background:#f1f5f9;">週休</th>
            <th style="background:#f1f5f9;">年</th>
            <th style="background:#f1f5f9;">研</th>
            <th style="background:#f1f5f9;">時間</th>
          </tr>
    `;

    for (const st of staffList) {
      const stats = validation.staffStats[st.id];
      const empLabel = st.employmentType === "part" ? "パート" : "常勤";
      const limitLabel =
        st.employmentType === "part"
          ? "-"
          : st.hasPersonalNightLimit
          ? `個別:${ stats.nightMax }回`
          : `${ stats.nightMax }回(均)`;

      html += `
        <tr>
          <td style="text-align:left; font-weight:bold;">${st.name}</td>
          <td>${empLabel}</td>
          <td>${limitLabel}</td>
      `;

      for (let d = 1; d <= daysInMonth; d++) {
        const sh = Validator.getShiftAt(schedule, st.id, d);
        const cell = schedule.cells && schedule.cells[st.id] && schedule.cells[st.id][d];
        const isManual = cell ? !!cell.isManual : false;
        const label = Validator.SHIFT_TYPES[sh] ? Validator.SHIFT_TYPES[sh].label : "休";
        const bg = isManual ? "#fef08a" : shiftColors[sh] || "#ffffff";
        const fg = isManual && sh === "N" ? "#1e1b4b" : shiftTextColors[sh] || "#000000";
        const borderStyle = isManual ? "border:2px solid #ca8a04; text-decoration:underline;" : "";
        html += `<td style="background:${bg}; color:${fg}; font-weight:bold; ${borderStyle}">${label}</td>`;
      }

      html += `
          <td>${stats.D}</td>
          <td>${stats.N}</td>
          <td>${stats.M}</td>
          <td>${stats.OFF}</td>
          <td>${stats.targetOff}</td>
          <td>${stats.PAID}</td>
          <td>${stats.TRAIN}</td>
          <td>${formatHours(stats.totalMinutes)}</td>
        </tr>
      `;
    }

    // 日別集計行
    const buildSummaryRow = (title, ruleText, getter, okChecker) => {
      let row = `<tr><td colspan="2" style="text-align:left; font-weight:bold; background:#f8fafc;">${title}</td><td style="background:#f8fafc; font-size:8.5pt;">${ruleText}</td>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const val = getter(validation.dayStats[d]);
        const ok = okChecker ? okChecker(validation.dayStats[d]) : true;
        const style = ok
          ? "background:#f8fafc; font-weight:bold;"
          : "background:#fee2e2; color:#dc2626; font-weight:bold;";
        row += `<td style="${style}">${val}</td>`;
      }
      row += `<td colspan="8" style="background:#f8fafc;"></td></tr>`;
      return row;
    };

    html += buildSummaryRow(
      "日勤 合計",
      "平2-3(パ含3-4)/休1-2",
      (ds) => ds.dTotal,
      (ds) => ds.dOk
    );
    html += buildSummaryRow(
      " └ うちパート",
      "8:30-14:00",
      (ds) => ds.dPart,
      null
    );
    html += buildSummaryRow(
      "夜勤 合計",
      "1〜2名",
      (ds) => ds.nCount,
      (ds) => ds.nOk
    );
    html += buildSummaryRow(
      "明け 合計",
      "前日夜と同数",
      (ds) => ds.mCount,
      null
    );

    html += `</table></body></html>`;

    const blob = new Blob(["\uFEFF" + html], {
      type: "application/vnd.ms-excel;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ナースエイド勤務表_${year}年${String(month).padStart(2, "0")}月.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * JSONファイルとして保存（バックアップ）
   */
  function exportToJson(appData, year, month) {
    const json = JSON.stringify(appData, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ナースエイド勤務表データ_${year}-${String(month).padStart(2, "0")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  global.Exporter = {
    formatHours,
    exportToExcel,
    exportToJson
  };
})(window);
