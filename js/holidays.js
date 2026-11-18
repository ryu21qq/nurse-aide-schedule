/**
 * 日本の祝日判定・カレンダーユーティリティ
 * 任意の年月の祝日自動算出＋画面上での手動休日トグルに対応
 */
(function (global) {
  function getNthMonday(year, month, n) {
    const firstDay = new Date(year, month - 1, 1).getDay();
    const firstMonday = firstDay <= 1 ? 1 + (1 - firstDay) : 1 + (8 - firstDay);
    return firstMonday + (n - 1) * 7;
  }

  function getVernalEquinoxDay(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function getAutumnalEquinoxDay(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  /**
   * 指定した年(year)・月(month: 1-12)の日本の祝日(日の配列)を返す
   */
  function getDefaultHolidaysForMonth(year, month) {
    const holidays = new Set();

    // 固定祝日・ハッピーマンデー・春分/秋分
    if (month === 1) {
      holidays.add(1); // 元日
      holidays.add(getNthMonday(year, 1, 2)); // 成人の日
    } else if (month === 2) {
      holidays.add(11); // 建国記念の日
      holidays.add(23); // 天皇誕生日
    } else if (month === 3) {
      holidays.add(getVernalEquinoxDay(year)); // 春分の日
    } else if (month === 4) {
      holidays.add(29); // 昭和の日
    } else if (month === 5) {
      holidays.add(3); // 憲法記念日
      holidays.add(4); // みどりの日
      holidays.add(5); // こどもの日
    } else if (month === 7) {
      holidays.add(getNthMonday(year, 7, 3)); // 海の日
    } else if (month === 8) {
      holidays.add(11); // 山の日
    } else if (month === 9) {
      const keirou = getNthMonday(year, 9, 3);
      const shuubun = getAutumnalEquinoxDay(year);
      holidays.add(keirou); // 敬老の日
      holidays.add(shuubun); // 秋分の日
      if (shuubun - keirou === 2) {
        holidays.add(keirou + 1); // 国民の休日
      }
    } else if (month === 10) {
      holidays.add(getNthMonday(year, 10, 2)); // スポーツの日
    } else if (month === 11) {
      holidays.add(3); // 文化の日
      holidays.add(23); // 勤労感謝の日
    }

    // 振替休日判定（祝日が日曜日の場合、以降の最初の平日を休日にする）
    const daysInMonth = new Date(year, month, 0).getDate();
    const baseHolidays = Array.from(holidays).sort((a, b) => a - b);
    for (const d of baseHolidays) {
      const dow = new Date(year, month - 1, d).getDay();
      if (dow === 0) {
        let sub = d + 1;
        while (holidays.has(sub) && sub <= daysInMonth) {
          sub++;
        }
        if (sub <= daysInMonth) {
          holidays.add(sub);
        }
      }
    }

    return Array.from(holidays).sort((a, b) => a - b);
  }

  /**
   * 土日または祝日かどうか判定する
   */
  function isHolidayOrWeekend(year, month, day, customHolidays) {
    const dow = new Date(year, month - 1, day).getDay();
    if (dow === 0 || dow === 6) return true;
    if (Array.isArray(customHolidays) && customHolidays.includes(day)) return true;
    return false;
  }

  /**
   * 指定月の「土日日数」「土日祝日数」「平日日数」を集計して返す（週休数の自動算出用）
   */
  function getMonthDayCounts(year, month, customHolidays) {
    const daysInMonth = new Date(year, month, 0).getDate();
    let weekendDays = 0;
    let holidayAndWeekendDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      const isWknd = dow === 0 || dow === 6;
      if (isWknd) weekendDays++;
      if (isHolidayOrWeekend(year, month, d, customHolidays)) {
        holidayAndWeekendDays++;
      }
    }
    return {
      daysInMonth,
      weekendDays,
      holidayAndWeekendDays,
      weekdays: daysInMonth - holidayAndWeekendDays
    };
  }

  const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  global.HolidayUtils = {
    getDefaultHolidaysForMonth,
    isHolidayOrWeekend,
    getMonthDayCounts,
    DOW_LABELS
  };
})(window);
