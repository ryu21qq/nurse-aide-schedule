/**
 * 勤務区分定義・ルール検証エンジン (validator.js)
 */
(function (global) {
  const SHIFT_TYPES = {
    D: {
      code: "D",
      label: "日",
      name: "日勤",
      fullTimeStr: "8:30-17:20",
      partTimeStr: "8:30-14:00",
      fullMinutes: 530, // 8時間50分 (8:30-17:20)
      partMinutes: 330, // 5時間30分 (8:30-14:00)
      isWork: true
    },
    N: {
      code: "N",
      label: "夜",
      name: "夜勤",
      fullTimeStr: "16:30-23:59",
      partTimeStr: "-",
      fullMinutes: 450, // 7時間30分相当 (16:30-24:00)
      partMinutes: 0,
      isWork: true
    },
    M: {
      code: "M",
      label: "明",
      name: "明け",
      fullTimeStr: "00:00-9:00",
      partTimeStr: "-",
      fullMinutes: 540, // 9時間00分 (00:00-9:00)
      partMinutes: 0,
      isWork: true
    },
    OFF: {
      code: "OFF",
      label: "休",
      name: "公休",
      fullTimeStr: "終日",
      partTimeStr: "終日",
      fullMinutes: 0,
      partMinutes: 0,
      isWork: false
    },
    PAID: {
      code: "PAID",
      label: "年",
      name: "年休",
      fullTimeStr: "終日",
      partTimeStr: "終日",
      fullMinutes: 0,
      partMinutes: 0,
      isWork: false
    },
    TRAIN: {
      code: "TRAIN",
      label: "研",
      name: "研修",
      fullTimeStr: "終日",
      partTimeStr: "終日",
      fullMinutes: 480,
      partMinutes: 330,
      isWork: true
    },
    NO_N: {
      code: "NO_N",
      label: "夜外",
      name: "夜勤以外(自動作成で日・明・休を割当)",
      fullTimeStr: "自動割当(日・明・休)",
      partTimeStr: "自動割当(日・休)",
      fullMinutes: 0,
      partMinutes: 0,
      isWork: false
    },
    M_OFF: {
      code: "M_OFF",
      label: "明/休",
      name: "明または休(自動作成で明・休を割当)",
      fullTimeStr: "自動割当(明・休)",
      partTimeStr: "休",
      fullMinutes: 0,
      partMinutes: 0,
      isWork: false
    }
  };

  const SHIFT_ORDER = ["D", "N", "M", "OFF", "PAID", "TRAIN", "NO_N", "M_OFF"];

  /**
   * スタッフの有効な夜勤上限を取得
   */
  function getEffectiveNightMax(staff) {
    if (staff.employmentType === "part") return 0;
    if (staff.hasPersonalNightLimit) {
      return Math.max(0, Math.min(6, Number(staff.personalNightMax ?? 0)));
    }
    return Math.max(0, Math.min(6, Number(staff.nightShiftMax ?? 6)));
  }

  /**
   * その月の基準週休数（常勤の所定「休」日数）を自動算出または設定値から取得する
   */
  function getMonthBaseWeeklyOff(year, month, schedule) {
    if (schedule && typeof schedule.baseWeeklyOff === "number" && !isNaN(schedule.baseWeeklyOff)) {
      return Math.max(0, Math.min(31, schedule.baseWeeklyOff));
    }
    const counts = HolidayUtils.getMonthDayCounts(year, month, schedule ? schedule.holidays : []);
    // デフォルトはその月の土日祝の日数（例：9〜11日）を自動表示
    return counts.holidayAndWeekendDays;
  }

  /**
   * スタッフ個人のその月の目標週休数（「休」の日数）を取得する
   */
  function getStaffTargetOff(year, month, schedule, staff) {
    if (
      schedule &&
      schedule.staffWeeklyOff &&
      schedule.staffWeeklyOff[staff.id] !== undefined &&
      schedule.staffWeeklyOff[staff.id] !== null &&
      schedule.staffWeeklyOff[staff.id] !== ""
    ) {
      return Math.max(0, Math.min(31, Number(schedule.staffWeeklyOff[staff.id])));
    }
    if (staff.employmentType === "part") {
      const counts = HolidayUtils.getMonthDayCounts(year, month, schedule ? schedule.holidays : []);
      // パートのデフォルト週休数：土日祝すべて＋平日週休分（月16日勤務ベース、テーブル上で自由に編集可能）
      const defaultPartWorkDays = Math.min(16, counts.weekdays);
      return daysInMonthFromYM(year, month) - defaultPartWorkDays;
    }
    return getMonthBaseWeeklyOff(year, month, schedule);
  }

  function daysInMonthFromYM(year, month) {
    return new Date(year, month, 0).getDate();
  }

  /**
   * スタッフのシフトを取得（d <= 0 は前月末データを参照）
   * d = 0: 前月末日 (prev1)
   * d = -1: 前々月末日 (prev2)
   */
  function getShiftAt(schedule, staffId, day) {
    if (day === 0) {
      return (schedule.prevMonth && schedule.prevMonth[staffId] && schedule.prevMonth[staffId].prev1) || "OFF";
    }
    if (day === -1) {
      return (schedule.prevMonth && schedule.prevMonth[staffId] && schedule.prevMonth[staffId].prev2) || "OFF";
    }
    const staffCells = schedule.cells && schedule.cells[staffId];
    if (!staffCells || !staffCells[day]) return "OFF";
    return staffCells[day].shift || "OFF";
  }

  /**
   * 月次勤務表全体の集計とルール検証を実行する
   */
  function validateSchedule(state) {
    const { year, month, staffList, schedule } = state;
    const daysInMonth = new Date(year, month, 0).getDate();
    const customHolidays = schedule.holidays || [];

    const errors = [];
    const warnings = [];
    const cellMarks = {}; // { `${staffId}_${day}`: "error" | "warning" }
    const dayStats = {};  // { [day]: { dFull, dPart, dTotal, nCount, mCount, offCount, isHoliday, dOk, nOk, dTargetText } }
    const staffStats = {}; // { [staffId]: { D, N, M, OFF, PAID, TRAIN, totalMinutes, nightMax } }

    function markCell(staffId, day, level) {
      if (day < 1 || day > daysInMonth) return;
      const key = `${staffId}_${day}`;
      if (cellMarks[key] === "error") return;
      cellMarks[key] = level;
    }

    // 1. 日別集計と人数ルール検証
    for (let d = 1; d <= daysInMonth; d++) {
      const isHoliday = HolidayUtils.isHolidayOrWeekend(year, month, d, customHolidays);
      let dFull = 0;
      let dPart = 0;
      let nCount = 0;
      let mCount = 0;
      let offCount = 0;

      for (const st of staffList) {
        const sh = getShiftAt(schedule, st.id, d);
        if (sh === "D") {
          if (st.employmentType === "part") dPart++;
          else dFull++;
        } else if (sh === "N") {
          nCount++;
        } else if (sh === "M") {
          mCount++;
        } else if (sh === "OFF" || sh === "PAID") {
          offCount++;
        }
      }

      const dTotal = dFull + dPart;
      let dOk = true;
      let dTargetText = "";

      if (isHoliday) {
        // 休日日勤: 1〜2名
        dTargetText = "1〜2";
        if (dTotal < 1 || dTotal > 2) {
          dOk = false;
          errors.push({
            type: "day_count",
            day: d,
            message: `${d}日(休): 日勤は1〜2名ですが現在 ${dTotal}名 です`
          });
        }
      } else {
        // 平日日勤: 2〜3名（パートを含む場合は3〜4名）
        if (dPart > 0) {
          dTargetText = "3〜4(パ含)";
          if (dTotal < 3 || dTotal > 4) {
            dOk = false;
            errors.push({
              type: "day_count",
              day: d,
              message: `${d}日(平): パートを含む日の日勤は3〜4名ですが現在 ${dTotal}名(常${dFull}+パ${dPart}) です`
            });
          }
        } else {
          dTargetText = "2〜3";
          if (dTotal < 2 || dTotal > 3) {
            dOk = false;
            errors.push({
              type: "day_count",
              day: d,
              message: `${d}日(平): 日勤は2〜3名ですが現在 ${dTotal}名 です`
            });
          }
        }
      }

      // 夜勤人数: 平日・休日ともに 1〜2名
      let nOk = true;
      if (nCount < 1 || nCount > 2) {
        nOk = false;
        errors.push({
          type: "night_count",
          day: d,
          message: `${d}日: 夜勤は1〜2名ですが現在 ${nCount}名 です`
        });
      }

      dayStats[d] = {
        dFull,
        dPart,
        dTotal,
        nCount,
        mCount,
        offCount,
        isHoliday,
        dOk,
        nOk,
        dTargetText
      };
    }

    // 2. スタッフ別集計と個別ルール検証
    for (const st of staffList) {
      const counts = { D: 0, N: 0, M: 0, OFF: 0, PAID: 0, TRAIN: 0 };
      let totalMinutes = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const sh = getShiftAt(schedule, st.id, d);
        if (counts[sh] !== undefined) counts[sh]++;
        const def = SHIFT_TYPES[sh];
        if (def) {
          totalMinutes += st.employmentType === "part" ? def.partMinutes : def.fullMinutes;
        }
      }

      const nightMax = getEffectiveNightMax(st);
      const targetOff = getStaffTargetOff(year, month, schedule, st);
      staffStats[st.id] = {
        ...counts,
        totalMinutes,
        nightMax,
        targetOff
      };

      // 2-1. パート制約チェック ＆ 「夜勤以外(noNight)」・「明/休(mOrOff)」チェック
      for (let d = 1; d <= daysInMonth; d++) {
        const cellObj = schedule.cells && schedule.cells[st.id] && schedule.cells[st.id][d];
        const sh = getShiftAt(schedule, st.id, d);
        if (cellObj && cellObj.noNight && sh === "N") {
          markCell(st.id, d, "error");
          errors.push({
            type: "no_night_violated",
            staffId: st.id,
            day: d,
            message: `${st.name}さん(${d}日): 「夜勤以外」指定の日に「夜」が入っています`
          });
        }
        if (cellObj && cellObj.mOrOff && sh !== "M" && sh !== "OFF" && sh !== "M_OFF") {
          markCell(st.id, d, "error");
          errors.push({
            type: "m_or_off_violated",
            staffId: st.id,
            day: d,
            message: `${st.name}さん(${d}日): 「明/休」指定の日に「${SHIFT_TYPES[sh] ? SHIFT_TYPES[sh].label : sh}」が入っています`
          });
        }
        if (sh === "NO_N") {
          markCell(st.id, d, "warning");
          warnings.push({
            type: "unassigned_no_n",
            staffId: st.id,
            day: d,
            message: `${st.name}さん(${d}日): 「夜勤以外(夜外)」が未割当です（「✨シフト自動作成」で日・明・休のいずれかが割り当てられます）`
          });
        } else if (sh === "M_OFF") {
          markCell(st.id, d, "warning");
          warnings.push({
            type: "unassigned_m_off",
            staffId: st.id,
            day: d,
            message: `${st.name}さん(${d}日): 「明/休」が未割当です（「✨シフト自動作成」で明・休のいずれかが割り当てられます）`
          });
        }
      }

      if (st.employmentType === "part") {
        for (let d = 1; d <= daysInMonth; d++) {
          const sh = getShiftAt(schedule, st.id, d);
          const isHol = dayStats[d].isHoliday;
          if (sh === "N" || sh === "M") {
            markCell(st.id, d, "error");
            errors.push({
              type: "part_invalid_shift",
              staffId: st.id,
              day: d,
              message: `${st.name}さん(${d}日): パートに「${SHIFT_TYPES[sh].label}」は割り当てできません`
            });
          }
          if (isHol && sh !== "OFF" && sh !== "PAID") {
            markCell(st.id, d, "error");
            errors.push({
              type: "part_holiday_work",
              staffId: st.id,
              day: d,
              message: `${st.name}さん(${d}日): パートは土日祝休みですが「${SHIFT_TYPES[sh].label}」が入っています`
            });
          }
        }
      }

      // 2-2. 「夜 → 明 → 休」100%セットチェック（前月末 d=-1, 0 からの引き継ぎも含む）
      for (let d = -1; d <= daysInMonth; d++) {
        const sh = getShiftAt(schedule, st.id, d);
        if (sh === "N") {
          // 翌日(d+1)は必ず「明」
          if (d + 1 >= 1 && d + 1 <= daysInMonth) {
            const next1 = getShiftAt(schedule, st.id, d + 1);
            if (next1 !== "M") {
              markCell(st.id, d, "error");
              markCell(st.id, d + 1, "error");
              errors.push({
                type: "night_set",
                staffId: st.id,
                day: d + 1,
                message: `${st.name}さん(${d <= 0 ? "前月末" : d + "日"}夜): 翌日(${d + 1}日)が「明」になっていません`
              });
            }
          }
          // 翌々日(d+2)は必ず「休」
          if (d + 2 >= 1 && d + 2 <= daysInMonth) {
            const next2 = getShiftAt(schedule, st.id, d + 2);
            if (next2 !== "OFF") {
              markCell(st.id, d, "error");
              markCell(st.id, d + 2, "error");
              errors.push({
                type: "night_set",
                staffId: st.id,
                day: d + 2,
                message: `${st.name}さん(${d <= 0 ? "前月末" : d + "日"}夜): 翌々日(${d + 2}日)が「休」になっていません`
              });
            }
          }
        }
      }

      // 単独の「明」チェック（前日が「夜」でない「明」はエラー）
      for (let d = 1; d <= daysInMonth; d++) {
        const sh = getShiftAt(schedule, st.id, d);
        if (sh === "M") {
          const prev = getShiftAt(schedule, st.id, d - 1);
          if (prev !== "N") {
            markCell(st.id, d, "error");
            errors.push({
              type: "orphan_m",
              staffId: st.id,
              day: d,
              message: `${st.name}さん(${d}日): 前日が「夜」ではないのに「明」が入っています`
            });
          }
          if (d + 1 <= daysInMonth) {
            const next = getShiftAt(schedule, st.id, d + 1);
            if (next !== "OFF") {
              markCell(st.id, d, "error");
              markCell(st.id, d + 1, "error");
              errors.push({
                type: "orphan_m_off",
                staffId: st.id,
                day: d + 1,
                message: `${st.name}さん(${d}日明): 翌日(${d + 1}日)が「休」になっていません`
              });
            }
          }
        }
      }

      // 2-3. 夜勤前の日勤連続数チェック
      // 基本: 0〜2日勤→夜 / 許容: 3日勤→夜 / 不可: 4日勤以上→夜
      for (let d = 1; d <= daysInMonth; d++) {
        const sh = getShiftAt(schedule, st.id, d);
        if (sh === "N") {
          let consecutiveD = 0;
          let cursor = d - 1;
          while (cursor >= -1) {
            const prevSh = getShiftAt(schedule, st.id, cursor);
            if (prevSh === "D" || prevSh === "TRAIN") {
              consecutiveD++;
              cursor--;
            } else {
              break;
            }
          }
          if (consecutiveD >= 4) {
            for (let k = 0; k <= consecutiveD; k++) {
              markCell(st.id, d - k, "error");
            }
            errors.push({
              type: "pre_night_d_limit",
              staffId: st.id,
              day: d,
              message: `${st.name}さん(${d}日夜): 夜勤前に${consecutiveD}日勤連続しています（4日勤夜勤は不可）`
            });
          } else if (consecutiveD === 3) {
            markCell(st.id, d, "warning");
            warnings.push({
              type: "pre_night_d_warn",
              staffId: st.id,
              day: d,
              message: `${st.name}さん(${d}日夜): 3日勤→夜勤となっています（許容範囲）`
            });
          }
        }
      }

      // 2-4. 連続夜勤チェック
      // 夜→明→休(3日)の直後にまた夜が来るパターン（d-3 が N かつ d が N）
      // 基本夜勤を続けてはならないが、2夜勤までは許容、3夜勤連続は不可
      for (let d = 1; d <= daysInMonth; d++) {
        const sh = getShiftAt(schedule, st.id, d);
        if (sh === "N") {
          const prevCycle1 = d - 3 >= -1 ? getShiftAt(schedule, st.id, d - 3) === "N" : false;
          const prevCycle2 = d - 6 >= -1 ? getShiftAt(schedule, st.id, d - 6) === "N" : false;

          if (prevCycle1 && prevCycle2) {
            markCell(st.id, d, "error");
            markCell(st.id, d - 3, "error");
            errors.push({
              type: "consecutive_night_error",
              staffId: st.id,
              day: d,
              message: `${st.name}さん(${d}日夜): 夜勤サイクルが3回連続しています（上限は2夜勤連続まで）`
            });
          } else if (prevCycle1) {
            markCell(st.id, d, "warning");
            warnings.push({
              type: "consecutive_night_warn",
              staffId: st.id,
              day: d,
              message: `${st.name}さん(${d}日夜): 2夜勤連続（夜・明・休・夜）となっています（許容範囲）`
            });
          }
        }
      }

      // 2-5. 連続日勤チェック（基本3日勤まで。4日勤は許容するが翌日は休とする）
      let dStreak = 0;
      for (let d = -1; d <= daysInMonth; d++) {
        const sh = getShiftAt(schedule, st.id, d);
        if (sh === "D") {
          dStreak++;
          if (d >= 1 && dStreak === 4) {
            if (d + 1 <= daysInMonth) {
              const nextSh = getShiftAt(schedule, st.id, d + 1);
              if (nextSh !== "OFF" && nextSh !== "PAID") {
                for (let k = 0; k <= 3; k++) {
                  markCell(st.id, d - k, "error");
                }
                markCell(st.id, d + 1, "error");
                errors.push({
                  type: "day_streak_over_4",
                  staffId: st.id,
                  day: d + 1,
                  message: `${st.name}さん(${d}日〜): 4日勤の翌日は「休」とするルールですが、翌日(${d + 1}日)が「${SHIFT_TYPES[nextSh] ? SHIFT_TYPES[nextSh].label : nextSh}」になっています`
                });
              } else {
                markCell(st.id, d, "warning");
                warnings.push({
                  type: "day_streak_4_warn",
                  staffId: st.id,
                  day: d,
                  message: `${st.name}さん(${d}日): 4連続日勤となっています（翌日休のため許容範囲・基本は3日勤まで）`
                });
              }
            } else {
              markCell(st.id, d, "warning");
              warnings.push({
                type: "day_streak_4_warn",
                staffId: st.id,
                day: d,
                message: `${st.name}さん(${d}日): 4連続日勤となっています（許容範囲・基本は3日勤まで）`
              });
            }
          } else if (d >= 1 && dStreak >= 5) {
            markCell(st.id, d, "error");
          }
        } else {
          dStreak = 0;
        }
      }

      // 2-6. 個人の夜勤上限チェック ＆ 設定週休数の厳守チェック（必須ルール）
      if (st.employmentType === "full") {
        if (counts.N > nightMax) {
          errors.push({
            type: "staff_night_max",
            staffId: st.id,
            message: `${st.name}さん: 夜勤回数が ${counts.N}回 で上限(${nightMax}回)を超えています`
          });
        }
      }

      if (counts.OFF !== targetOff) {
        errors.push({
          type: "staff_weekly_off_strict",
          staffId: st.id,
          message: `${st.name}さん: 「休」が ${counts.OFF}日 です（設定週休数 ${targetOff}日 を厳守してください）`
        });
      }
    }

    // 3. 夜勤回数の均等化チェック（個人事情のない常勤スタッフ間）
    const standardFullStaff = staffList.filter(
      (s) => s.employmentType === "full" && !s.hasPersonalNightLimit && getEffectiveNightMax(s) > 0
    );
    if (standardFullStaff.length >= 2) {
      const nCounts = standardFullStaff.map((s) => staffStats[s.id].N);
      const minN = Math.min(...nCounts);
      const maxN = Math.max(...nCounts);
      if (maxN - minN >= 2) {
        warnings.push({
          type: "night_balance",
          message: `通常枠スタッフ間の夜勤回数に差があります（最小 ${minN}回 〜 最大 ${maxN}回）`
        });
      }
    }

    return {
      errors,
      warnings,
      cellMarks,
      dayStats,
      staffStats
    };
  }

  global.Validator = {
    SHIFT_TYPES,
    SHIFT_ORDER,
    getEffectiveNightMax,
    getMonthBaseWeeklyOff,
    getStaffTargetOff,
    getShiftAt,
    validateSchedule
  };
})(window);
