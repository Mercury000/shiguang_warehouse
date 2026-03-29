(function () {
    function showToast(message) {
        if (typeof AndroidBridge !== "undefined" && AndroidBridge.showToast) {
            AndroidBridge.showToast(String(message || ""));
        } else {
            console.log(message);
        }
    }

    function ensureBridgePromise() {
        if (!window.AndroidBridgePromise) {
            throw new Error("AndroidBridgePromise is unavailable.");
        }
    }

    function getBaseOrigin() {
        return window.location.origin;
    }

    async function requestText(url, options) {
        const response = await fetch(url, {
            credentials: "include",
            ...(options || {})
        });

        if (!response.ok) {
            throw new Error(`Request failed (${response.status}): ${url}`);
        }

        return response.text();
    }

    function parseEntryParams(entryHtml) {
        const html = String(entryHtml || "");
        const idsMatch = html.match(/bg\.form\.addInput\(form,"ids","(\d+)"\)/);
        const tagIdMatch = html.match(/id="(semesterBar\d+Semester)"/);

        return {
            studentId: idsMatch ? idsMatch[1] : "",
            tagId: tagIdMatch ? tagIdMatch[1] : ""
        };
    }

    function formatSemesterName(schoolYear, termName) {
        const suffixMap = {
            "1": "第一学期",
            "2": "第二学期",
            "3": "第三学期"
        };
        const suffix = suffixMap[String(termName || "").trim()] || `第${String(termName || "").trim()}学期`;
        return `${String(schoolYear || "").trim()}学年${suffix}`;
    }

    function parseSemesterResponse(rawText) {
        let data;
        try {
            data = Function(`return (${String(rawText || "").trim()});`)();
        } catch (_) {
            throw new Error("Failed to parse semester response.");
        }

        const semesters = [];
        if (!data || !data.semesters || typeof data.semesters !== "object") {
            return semesters;
        }

        Object.keys(data.semesters).forEach((key) => {
            const list = data.semesters[key];
            if (!Array.isArray(list)) return;

            list.forEach((semester) => {
                if (!semester || !semester.id) return;
                const schoolYear = String(semester.schoolYear || "").trim();
                const termName = String(semester.name || "").trim();
                semesters.push({
                    id: String(semester.id),
                    schoolYear,
                    termName,
                    name: formatSemesterName(schoolYear, termName)
                });
            });
        });

        return semesters;
    }

    function parseStudentProfile(htmlText) {
        const html = String(htmlText || "");
        const allDates = html.match(/\d{4}-\d{2}-\d{2}/g) || [];
        const enrollmentDate = allDates[0] || "";

        return {
            enrollmentDate,
            enrollmentYear: enrollmentDate ? Number(enrollmentDate.slice(0, 4)) : 0
        };
    }

    function filterSemestersByEnrollmentYear(semesters, enrollmentYear) {
        if (!enrollmentYear) return semesters;

        const filtered = semesters.filter((semester) => {
            const startYear = Number(String(semester.schoolYear || "").split("-")[0]);
            return startYear >= enrollmentYear;
        });

        return filtered.length ? filtered : semesters;
    }

    function normalizeEnglishDate(dateText) {
        const parsed = new Date(String(dateText || ""));
        if (Number.isNaN(parsed.getTime())) return "";
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, "0");
        const day = String(parsed.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function parseCalendarInfo(htmlText) {
        const html = String(htmlText || "");
        const match = html.match(/([A-Za-z]{3}\s+\d{1,2},\s+\d{4})~([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*\((\d+)\)/);
        if (!match) {
            return {
                semesterStartDate: "",
                semesterTotalWeeks: 0
            };
        }

        return {
            semesterStartDate: normalizeEnglishDate(match[1]),
            semesterTotalWeeks: Number(match[3] || 0)
        };
    }

    function chineseSectionToNumber(text) {
        const mapping = {
            "一": 1,
            "二": 2,
            "三": 3,
            "四": 4,
            "五": 5,
            "六": 6,
            "七": 7,
            "八": 8,
            "九": 9,
            "十": 10,
            "十一": 11
        };
        return mapping[String(text || "").trim()] || 0;
    }

    function parseTimeSlotsFromHtml(htmlText) {
        const doc = new DOMParser().parseFromString(String(htmlText || ""), "text/html");
        const slots = [];

        doc.querySelectorAll("#manualArrangeCourseTable tbody tr").forEach((row) => {
            const cells = Array.from(row.querySelectorAll("td"));
            const sectionCell = cells.find((cell) => /第.+节/.test(cell.textContent || ""));
            if (!sectionCell) return;

            const text = sectionCell.textContent.replace(/\s+/g, " ").trim();
            const match = text.match(/第([一二三四五六七八九十十一]+)节\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
            if (!match) return;

            const sectionNumber = chineseSectionToNumber(match[1]);
            if (!sectionNumber) return;

            slots.push({
                number: sectionNumber,
                startTime: match[2],
                endTime: match[3]
            });
        });

        return slots.sort((a, b) => a.number - b.number);
    }

    function splitJsArgs(argsText) {
        const args = [];
        let current = "";
        let quote = "";
        let escaped = false;

        for (let i = 0; i < argsText.length; i++) {
            const ch = argsText[i];

            if (escaped) {
                current += ch;
                escaped = false;
                continue;
            }

            if (ch === "\\") {
                current += ch;
                escaped = true;
                continue;
            }

            if (quote) {
                current += ch;
                if (ch === quote) quote = "";
                continue;
            }

            if (ch === "'" || ch === "\"") {
                current += ch;
                quote = ch;
                continue;
            }

            if (ch === ",") {
                args.push(current.trim());
                current = "";
                continue;
            }

            current += ch;
        }

        if (current.trim()) {
            args.push(current.trim());
        }

        return args;
    }

    function unquoteJsLiteral(token) {
        const text = String(token || "").trim();
        if (!text || text === "null" || text === "undefined") return "";

        if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
            const quote = text[0];
            return text.slice(1, -1)
                .replace(/\\\\/g, "\\")
                .replace(new RegExp(`\\\\${quote}`, "g"), quote)
                .replace(/\\n/g, "\n")
                .replace(/\\r/g, "\r")
                .replace(/\\t/g, "\t");
        }

        return text;
    }

    function parseValidWeeksBitmap(bitmap) {
        const weeks = [];
        const text = String(bitmap || "");
        for (let i = 0; i < text.length; i++) {
            if (text[i] === "1" && i >= 1) {
                weeks.push(i);
            }
        }
        return weeks;
    }

    function normalizeWeeks(weeks) {
        return Array.from(new Set((weeks || []).filter((week) => Number.isInteger(week) && week > 0))).sort((a, b) => a - b);
    }

    function cleanCourseName(name) {
        return String(name || "").replace(/\(\d+\)\s*$/, "").trim();
    }

    function resolveTeachersForTaskActivityBlock(fullText, blockStartIndex) {
        const start = Math.max(0, blockStartIndex - 2500);
        const segment = fullText.slice(start, blockStartIndex);
        const teachersRegex = /var\s+teachers\s*=\s*\[([^]*?)\];/g;
        let lastTeachersBlock = "";
        let match;

        while ((match = teachersRegex.exec(segment)) !== null) {
            lastTeachersBlock = match[1] || "";
        }

        if (!lastTeachersBlock) return "";

        const names = [];
        const nameRegex = /name\s*:\s*(?:"([^"]*)"|'([^']*)')/g;
        let nameMatch;
        while ((nameMatch = nameRegex.exec(lastTeachersBlock)) !== null) {
            const name = (nameMatch[1] || nameMatch[2] || "").trim();
            if (name) names.push(name);
        }

        return Array.from(new Set(names)).join(",");
    }

    function mergeContiguousSections(courses) {
        const normalized = (courses || []).map((course) => ({
            ...course,
            weeks: normalizeWeeks(course.weeks)
        }));

        normalized.sort((a, b) => {
            const keyA = `${a.name}|${a.teacher}|${a.position}|${a.day}|${a.weeks.join(",")}`;
            const keyB = `${b.name}|${b.teacher}|${b.position}|${b.day}|${b.weeks.join(",")}`;
            if (keyA < keyB) return -1;
            if (keyA > keyB) return 1;
            return a.startSection - b.startSection;
        });

        const merged = [];
        normalized.forEach((course) => {
            const previous = merged[merged.length - 1];
            const canMerge = previous
                && previous.name === course.name
                && previous.teacher === course.teacher
                && previous.position === course.position
                && previous.day === course.day
                && previous.weeks.join(",") === course.weeks.join(",")
                && previous.endSection + 1 >= course.startSection;

            if (canMerge) {
                previous.endSection = Math.max(previous.endSection, course.endSection);
            } else {
                merged.push({ ...course });
            }
        });

        return merged;
    }

    function parseCoursesFromTaskActivityScript(htmlText) {
        const text = String(htmlText || "");
        const unitCountMatch = text.match(/\bvar\s+unitCount\s*=\s*(\d+)\s*;/);
        const unitCount = unitCountMatch ? Number(unitCountMatch[1]) : 0;
        if (!unitCount) return [];

        const courses = [];
        const blockRegex = /activity\s*=\s*new\s+TaskActivity\(([^]*?)\)\s*;\s*index\s*=\s*(?:(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)|(\d+))\s*;\s*table\d+\.activities\[index\]/g;
        let match;

        while ((match = blockRegex.exec(text)) !== null) {
            const args = splitJsArgs(match[1] || "");
            if (args.length < 7) continue;

            let linearIndex = -1;
            if (match[2] != null && match[3] != null) {
                linearIndex = Number(match[2]) * unitCount + Number(match[3]);
            } else if (match[4] != null) {
                linearIndex = Number(match[4]);
            }
            if (linearIndex < 0) continue;

            const day = Math.floor(linearIndex / unitCount) + 1;
            const section = (linearIndex % unitCount) + 1;
            if (day < 1 || day > 7) continue;

            let teacher = unquoteJsLiteral(args[1]);
            if (/join\s*\(/.test(String(args[1] || ""))) {
                teacher = resolveTeachersForTaskActivityBlock(text, match.index) || teacher;
            }

            const name = cleanCourseName(unquoteJsLiteral(args[3]));
            const position = unquoteJsLiteral(args[5]).replace(/\s+/g, " ").trim();
            const weeks = normalizeWeeks(parseValidWeeksBitmap(unquoteJsLiteral(args[6])));
            if (!name) continue;

            courses.push({
                name,
                teacher: teacher || "未知教师",
                position: position || "待定",
                day,
                startSection: section,
                endSection: section,
                weeks
            });
        }

        return mergeContiguousSections(courses);
    }

    async function fetchEntryParams() {
        const entryHtml = await requestText(`${getBaseOrigin()}/eams/courseTableForStd.action?&sf_request_type=ajax`, {
            method: "GET",
            headers: {
                "x-requested-with": "XMLHttpRequest"
            }
        });

        return parseEntryParams(entryHtml);
    }

    async function fetchStudentProfile() {
        const profileHtml = await requestText(`${getBaseOrigin()}/eams/stdInfoApply!stdInfoCheck.action?_=${Date.now()}`, {
            method: "GET",
            headers: {
                accept: "text/html, */*; q=0.01",
                "x-requested-with": "XMLHttpRequest"
            }
        });

        return parseStudentProfile(profileHtml);
    }

    async function fetchSemesters(tagId) {
        const semesterRaw = await requestText(`${getBaseOrigin()}/eams/dataQuery.action?sf_request_type=ajax`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
            },
            body: `tagId=${encodeURIComponent(tagId)}&dataType=semesterCalendar&empty=false`
        });

        return parseSemesterResponse(semesterRaw);
    }

    async function fetchCourseHtml(studentId, semesterId) {
        return requestText(`${getBaseOrigin()}/eams/courseTableForStd!courseTable.action?sf_request_type=ajax`, {
            method: "POST",
            headers: {
                accept: "*/*",
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "x-requested-with": "XMLHttpRequest"
            },
            body: [
                "ignoreHead=1",
                "setting.kind=std",
                "startWeek=",
                `semester.id=${encodeURIComponent(semesterId)}`,
                `ids=${encodeURIComponent(studentId)}`
            ].join("&")
        });
    }

    async function fetchCalendarInfo(semesterId) {
        const calendarHtml = await requestText(`${getBaseOrigin()}/eams/base/calendar-info.action`, {
            method: "POST",
            headers: {
                accept: "text/html, */*; q=0.01",
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "x-requested-with": "XMLHttpRequest"
            },
            body: `version=1&semesterId=${encodeURIComponent(semesterId)}`
        });

        return parseCalendarInfo(calendarHtml);
    }

    async function selectSemester(semesters) {
        const recent = semesters.slice(-8);
        const selectedIndex = await window.AndroidBridgePromise.showSingleSelection(
            "选择要导入的学期",
            JSON.stringify(recent.map((semester) => semester.name || semester.id)),
            recent.length - 1
        );

        if (selectedIndex === null || selectedIndex === -1) {
            throw new Error("已取消导入。");
        }

        return recent[selectedIndex];
    }

    async function runImportFlow() {
        ensureBridgePromise();

        showToast("正在识别课表参数...");
        const params = await fetchEntryParams();
        if (!params.studentId || !params.tagId) {
            throw new Error("未能自动识别学生ID或学期参数，请先进入课表页面。");
        }

        showToast("正在获取学籍信息...");
        const studentProfile = await fetchStudentProfile();

        showToast("正在获取学期列表...");
        const semesters = filterSemestersByEnrollmentYear(
            await fetchSemesters(params.tagId),
            studentProfile.enrollmentYear
        );
        if (!semesters.length) {
            throw new Error("未获取到学期列表。");
        }

        const selectedSemester = await selectSemester(semesters);

        showToast(`正在获取 ${selectedSemester.name} 课表...`);
        const courseHtml = await fetchCourseHtml(params.studentId, selectedSemester.id);
        const timeSlots = parseTimeSlotsFromHtml(courseHtml);
        const courses = parseCoursesFromTaskActivityScript(courseHtml);
        const calendarInfo = await fetchCalendarInfo(selectedSemester.id);

        if (!courses.length) {
            console.log(courseHtml);
            throw new Error("未解析到课程数据，请确认当前学期有课表。");
        }

        const config = {
            firstDayOfWeek: 1
        };
        if (calendarInfo.semesterStartDate) {
            config.semesterStartDate = calendarInfo.semesterStartDate;
        }
        if (calendarInfo.semesterTotalWeeks) {
            config.semesterTotalWeeks = calendarInfo.semesterTotalWeeks;
        }

        await window.AndroidBridgePromise.saveCourseConfig(JSON.stringify(config));
        await window.AndroidBridgePromise.saveImportedCourses(JSON.stringify(courses));
        if (timeSlots.length) {
            await window.AndroidBridgePromise.savePresetTimeSlots(JSON.stringify(timeSlots));
        }

        showToast(`导入完成，共 ${courses.length} 门课程`);
        if (typeof AndroidBridge !== "undefined" && AndroidBridge.notifyTaskCompletion) {
            AndroidBridge.notifyTaskCompletion();
        }
    }

    (async function bootstrap() {
        try {
            await runImportFlow();
        } catch (error) {
            console.error(error);
            showToast(`导入失败: ${error.message || error}`);
        }
    })();
})();
