/**
 * AutoPilot Extension for SillyTavern
 *
 * Features:
 * - Independent auto-dialogue timer for group chats
 * - Turn limit control (set max turns, auto-stop when reached)
 * - Story Director: periodically injects plot developments
 * - Plot direction control (genre + goal + custom hints)
 * - Character filter (select which characters participate)
 * - Manual trigger buttons (next turn now, director now, pause/resume)
 * - Auto-start when opening group chats
 * - Settings persisted via extension_settings
 * - No core file modifications required
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { selected_group, groups, is_group_generating, generateGroupWrapper } from '../../../group-chats.js';

// ==================== Constants ====================

const MODULE_KEY = 'autopilot';
const EXTENSION_NAME = 'third-party/autopilot';

const PLOT_GENRES = {
    'free': '自由（无主题）',
    'adventure': '冒险',
    'romance': '恋爱',
    'mystery': '悬疑',
    'comedy': '喜剧',
    'drama': '剧情',
    'horror': '恐怖',
    'scifi': '科幻',
    'fantasy': '奇幻',
    'action': '动作',
    'slice': '日常',
};

const DEFAULT_DIRECTOR_PROMPT = [
    'You are a creative story director for an ongoing roleplay.',
    'Based on the conversation so far, write a brief 1-3 sentence narrative event',
    'that introduces a new plot element, complication, or interesting development',
    'to keep the story engaging and moving forward.',
    'Write in third person narrative style.',
    'Do not write dialogue for any character.',
    'Focus on action, environment changes, or plot progression.',
    'Be creative and surprising.',
].join(' ');

const defaultSettings = {
    autoStart: false,
    delay: 5,
    maxTurns: 0,           // 0 = unlimited
    // Story Director
    storyDirector: false,
    directorInterval: 5,
    directorPrompt: DEFAULT_DIRECTOR_PROMPT,
    // Plot direction control
    plotDirection: '',     // User-specified plot goal/direction
    plotGenre: 'free',     // Genre theme
    plotIntensity: 'medium', // low, medium, high
    // Character filter
    characterFilter: [],   // empty = all characters; array of character names
    // Stats
    stats: {
        totalMessages: 0,
        directorInterventions: 0,
    },
};

// ==================== State ====================

let autopilotTimer = null;
let autopilotAbortController = null;
let turnCount = 0;
let isRunning = false;
let isPaused = false;
let uiInjected = false;
let extUiInjected = false;

// ==================== Settings ====================

function loadSettings() {
    if (!extension_settings[MODULE_KEY]) {
        extension_settings[MODULE_KEY] = {};
    }
    Object.assign(extension_settings[MODULE_KEY], defaultSettings);
    // Ensure new fields are added for upgrades
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_KEY][key] === undefined) {
            extension_settings[MODULE_KEY][key] = defaultSettings[key];
        }
    }
    // Ensure stats object exists
    if (!extension_settings[MODULE_KEY].stats) {
        extension_settings[MODULE_KEY].stats = { totalMessages: 0, directorInterventions: 0 };
    }
    // Ensure characterFilter is an array
    if (!Array.isArray(extension_settings[MODULE_KEY].characterFilter)) {
        extension_settings[MODULE_KEY].characterFilter = [];
    }
}

function getSettings() {
    return extension_settings[MODULE_KEY] || defaultSettings;
}

function saveSettings() {
    saveSettingsDebounced();
}

// ==================== Core: AutoPilot Worker ====================

async function autopilotWorker() {
    if (!isRunning || isPaused) return;

    const ctx = getContext();
    const settings = getSettings();

    // Skip if no connection, not in group, or already generating
    if (ctx.onlineStatus === 'no_connection') return;
    if (!selected_group || is_group_generating) return;

    const group = groups.find((x) => x.id === selected_group);
    if (!group || !Array.isArray(group.members) || !group.members.length) return;

    // Check turn limit
    if (settings.maxTurns > 0 && turnCount >= settings.maxTurns) {
        toastr.info(`已达到 ${settings.maxTurns} 轮，AutoPilot 自动停止。`, 'AutoPilot', { timeOut: 4000 });
        stopAutoPilot();
        return;
    }

    // Trigger one round of group generation
    autopilotAbortController = new AbortController();
    try {
        await generateGroupWrapper(true, 'auto', {
            signal: autopilotAbortController.signal,
        });
    } catch (e) {
        console.debug('[AutoPilot] Generation skipped or aborted:', e.message);
        return;
    }

    // Update stats and turn count
    turnCount++;
    settings.stats.totalMessages++;
    saveSettings();
    updateTurnDisplay();

    // Story Director intervention
    if (settings.storyDirector) {
        if (turnCount % settings.directorInterval === 0) {
            await storyDirectorIntervene();
        }
    }
}

// ==================== Story Director ====================

function buildDirectorPrompt() {
    const settings = getSettings();
    let prompt = settings.directorPrompt || DEFAULT_DIRECTOR_PROMPT;

    // Add genre if specified
    if (settings.plotGenre && settings.plotGenre !== 'free') {
        const genreName = PLOT_GENRES[settings.plotGenre] || settings.plotGenre;
        prompt += `\n\nThe story genre is: ${genreName}. Keep developments consistent with this genre.`;
    }

    // Add active characters if character filter is set
    if (Array.isArray(settings.characterFilter) && settings.characterFilter.length > 0) {
        prompt += `\n\nThe active characters in this scene are: ${settings.characterFilter.join(', ')}. Focus your narrative developments on these characters.`;
    }

    // Add intensity
    const intensityMap = {
        'low': 'Keep developments subtle and gradual.',
        'medium': 'Balance between subtle and dramatic developments.',
        'high': 'Introduce dramatic, exciting, and impactful developments.',
    };
    prompt += `\n\nIntensity: ${intensityMap[settings.plotIntensity] || intensityMap['medium']}`;

    // Add plot direction if specified
    if (settings.plotDirection && settings.plotDirection.trim()) {
        prompt += `\n\nImportant plot direction from the user: ${settings.plotDirection.trim()}`;
        prompt += '\nSteer the story toward this direction. Do not resolve it too quickly.';
    }

    return prompt;
}

async function storyDirectorIntervene() {
    const ctx = getContext();
    const settings = getSettings();
    const prompt = buildDirectorPrompt();

    toastr.info('剧情导演正在生成剧情发展...', 'AutoPilot', { timeOut: 3000 });

    try {
        const direction = await ctx.generateQuietPrompt({
            quietPrompt: prompt,
            quietToLoud: false,
            skipWIAN: true,
        });

        if (direction && direction.trim()) {
            const narratorText = `[Narrator] ${direction.trim()}`;

            // Inject as a user message so AI characters can react to it
            const message = {
                name: ctx.name1,
                is_user: true,
                is_system: false,
                mes: narratorText,
                send_date: getMessageTimeStamp(),
                extra: {},
                swipe_id: 0,
                swipes: [narratorText],
            };

            ctx.chat.push(message);
            ctx.addOneMessage(message);
            await ctx.saveChat();

            settings.stats.directorInterventions++;
            saveSettings();
            updateTurnDisplay();

            const preview = direction.trim().substring(0, 80);
            toastr.success(preview + '...', '剧情导演', { timeOut: 5000 });
        }
    } catch (e) {
        console.error('[AutoPilot] Story Director error:', e);
        toastr.warning('剧情导演遇到错误。', 'AutoPilot');
    }
}

// Helper: generate a timestamp string matching SillyTavern's format
function getMessageTimeStamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} @${hours}h ${minutes}m ${seconds}s`;
}

// ==================== Start / Stop / Pause ====================

function startAutoPilot() {
    if (isRunning) return;
    const settings = getSettings();
    isRunning = true;
    isPaused = false;
    turnCount = 0;

    const delayMs = Math.max(1, settings.delay) * 1000;
    autopilotTimer = setInterval(autopilotWorker, delayMs);

    // Update UI
    $('#autopilot_toggle').prop('checked', true);
    $('#autopilot_ext_toggle').prop('checked', true);
    updateStatusDisplay();

    // Stop when generation is manually stopped
    eventSource.once(event_types.GENERATION_STOPPED, () => {
        if (autopilotAbortController) {
            autopilotAbortController.abort();
        }
    });

    const turnsInfo = settings.maxTurns > 0 ? `（最多 ${settings.maxTurns} 轮）` : '（无限轮次）';
    toastr.success(`AutoPilot 已启动！${turnsInfo}`, 'AutoPilot', { timeOut: 3000 });
    updateTurnDisplay();
}

function stopAutoPilot() {
    isRunning = false;
    isPaused = false;
    turnCount = 0;

    if (autopilotTimer) {
        clearInterval(autopilotTimer);
        autopilotTimer = null;
    }

    if (autopilotAbortController) {
        autopilotAbortController.abort();
        autopilotAbortController = null;
    }

    // Update UI
    $('#autopilot_toggle').prop('checked', false);
    $('#autopilot_ext_toggle').prop('checked', false);
    updateStatusDisplay();
    updateTurnDisplay();

    toastr.info('AutoPilot 已停止。', 'AutoPilot', { timeOut: 2000 });
}

function pauseAutoPilot() {
    if (!isRunning || isPaused) return;
    isPaused = true;
    updateStatusDisplay();
    toastr.info('AutoPilot 已暂停。', 'AutoPilot', { timeOut: 2000 });
}

function resumeAutoPilot() {
    if (!isRunning || !isPaused) return;
    isPaused = false;
    updateStatusDisplay();
    toastr.info('AutoPilot 已恢复。', 'AutoPilot', { timeOut: 2000 });
}

function toggleAutoPilot() {
    if (isRunning) {
        stopAutoPilot();
    } else {
        startAutoPilot();
    }
}

function togglePause() {
    if (!isRunning) return;
    if (isPaused) {
        resumeAutoPilot();
    } else {
        pauseAutoPilot();
    }
}

// Manual trigger: generate one turn immediately
async function triggerNextTurnNow() {
    if (!isRunning) {
        toastr.warning('请先启动 AutoPilot。', 'AutoPilot');
        return;
    }
    if (is_group_generating) {
        toastr.warning('正在生成中，请稍候...', 'AutoPilot');
        return;
    }
    toastr.info('正在触发下一轮...', 'AutoPilot', { timeOut: 1500 });
    await autopilotWorker();
}

// Manual trigger: director intervenes now
async function triggerDirectorNow() {
    if (!selected_group) {
        toastr.warning('请先打开群聊。', 'AutoPilot');
        return;
    }
    toastr.info('剧情导演正在介入...', 'AutoPilot', { timeOut: 2000 });
    await storyDirectorIntervene();
}

// ==================== Auto-Start ====================

function onChatChanged() {
    const ctx = getContext();
    const settings = getSettings();

    // Only auto-start for group chats
    if (settings.autoStart && ctx.groupId && !isRunning) {
        setTimeout(() => {
            if (ctx.groupId && !isRunning && getContext().onlineStatus !== 'no_connection') {
                startAutoPilot();
            }
        }, 2000);
    }

    // Stop when leaving a group chat
    if (!ctx.groupId && isRunning) {
        stopAutoPilot();
    }

    // Refresh character list when chat changes
    refreshCharacterList();
}

// ==================== Character Filter ====================

function getGroupCharacterNames() {
    if (!selected_group) return [];
    const group = groups.find((x) => x.id === selected_group);
    if (!group || !Array.isArray(group.members)) return [];

    const ctx = getContext();
    const names = [];
    for (const memberId of group.members) {
        // Try to find character name from characters array
        const char = ctx.characters && ctx.characters.find(c => c.avatar === memberId);
        if (char && char.name) {
            names.push(char.name);
        }
    }
    return names;
}

function refreshCharacterList() {
    const names = getGroupCharacterNames();
    const settings = getSettings();

    // Render character filter checkboxes
    const container = $('#autopilot_ext_char_list');
    if (container.length === 0) return;

    if (names.length === 0) {
        container.html('<span style="opacity:0.5; font-size:11px;">打开群聊后显示角色列表</span>');
        return;
    }

    let html = '';
    // "All characters" option
    html += `<label class="checkbox_label whitespacenowrap" style="font-size:12px;" title="使用群聊中所有角色">
        <input id="autopilot_ext_char_all" type="checkbox" ${settings.characterFilter.length === 0 ? 'checked' : ''} />
        <span>全部角色</span>
    </label>`;

    // Individual characters
    for (const name of names) {
        const checked = settings.characterFilter.includes(name);
        html += `<label class="checkbox_label whitespacenowrap" style="font-size:12px; margin-left:12px;" title="选择此角色参与自动对话">
            <input class="autopilot-char-cb" type="checkbox" data-name="${escapeHtml(name)}" ${checked ? 'checked' : ''} />
            <span>${escapeHtml(name)}</span>
        </label>`;
    }
    container.html(html);

    // Bind events
    $('#autopilot_ext_char_all').off('input').on('input', function() {
        if ($(this).prop('checked')) {
            getSettings().characterFilter = [];
            saveSettings();
            $('.autopilot-char-cb').prop('checked', false);
        }
    });

    $('.autopilot-char-cb').off('input').on('input', function() {
        const name = $(this).data('name');
        const filter = getSettings().characterFilter;
        if ($(this).prop('checked')) {
            if (!filter.includes(name)) filter.push(name);
        } else {
            const idx = filter.indexOf(name);
            if (idx >= 0) filter.splice(idx, 1);
        }
        // Update "All" checkbox
        $('#autopilot_ext_char_all').prop('checked', filter.length === 0);
        saveSettings();
    });
}

// ==================== UI Display Updates ====================

function updateStatusDisplay() {
    let statusText = '已停止';
    let statusClass = 'autopilot-off';

    if (isRunning) {
        if (isPaused) {
            statusText = '已暂停';
            statusClass = 'autopilot-paused';
        } else {
            statusText = '运行中';
            statusClass = 'autopilot-on';
        }
    }

    $('#autopilot_status').removeClass('autopilot-on autopilot-off autopilot-paused').addClass(statusClass).text(statusText);
    $('#autopilot_ext_status').removeClass('autopilot-on autopilot-off autopilot-paused').addClass(statusClass).text(statusText);

    // Update pause button text
    const pauseText = isPaused ? '继续' : '暂停';
    $('#autopilot_ext_pause_btn').text(pauseText);
}

function updateTurnDisplay() {
    const settings = getSettings();
    const maxStr = settings.maxTurns > 0 ? ` / ${settings.maxTurns}` : '';
    const turnStr = `轮次: ${turnCount}${maxStr}`;

    $('#autopilot_ext_turn_display').text(turnStr);
    $('#autopilot_ext_stat_msgs').text(settings.stats.totalMessages);
    $('#autopilot_ext_stat_dirs').text(settings.stats.directorInterventions);
}

// ==================== UI Injection ====================

function buildSettingsHTML() {
    const settings = getSettings();

    // Build genre options
    let genreOptions = '';
    for (const [key, label] of Object.entries(PLOT_GENRES)) {
        genreOptions += `<option value="${key}" ${settings.plotGenre === key ? 'selected' : ''}>${label}</option>`;
    }

    return `
    <div class="autopilot_section_title"><i class="fa-solid fa-gauge-high"></i> 运行控制</div>
    <div class="autopilot_row">
        <span title="每轮自动对话之间的间隔（秒）">间隔(秒):</span>
        <input id="autopilot_ext_delay" class="text_pole textarea_compact" type="number" min="1" max="120" step="1" value="${settings.delay}" style="width: 60px;" />
        <span title="达到此轮次后自动停止（0 = 无限）">最大轮次:</span>
        <input id="autopilot_ext_max_turns" class="text_pole textarea_compact" type="number" min="0" max="9999" step="1" value="${settings.maxTurns}" style="width: 60px;" />
    </div>
    <div class="autopilot_row">
        <span id="autopilot_ext_turn_display" class="autopilot-turn-counter">轮次: 0</span>
    </div>
    <div class="autopilot_button_row">
        <button id="autopilot_ext_pause_btn" class="menu_button menu_button_small" title="暂停/恢复自动对话"><i class="fa-solid fa-pause"></i> 暂停</button>
        <button id="autopilot_ext_next_btn" class="menu_button menu_button_small" title="立即触发下一轮对话"><i class="fa-solid fa-forward-step"></i> 下一轮</button>
        <button id="autopilot_ext_director_btn" class="menu_button menu_button_small" title="立即触发剧情导演"><i class="fa-solid fa-clapperboard"></i> 导演介入</button>
    </div>

    <div class="autopilot_section_title"><i class="fa-solid fa-clapperboard"></i> 剧情导演</div>
    <label class="checkbox_label whitespacenowrap" title="剧情导演会定期注入剧情发展">
        <input id="autopilot_ext_director" type="checkbox" />
        <span>启用剧情导演</span>
    </label>
    <div id="autopilot_ext_director_settings" class="autopilot-director-settings ${settings.storyDirector ? '' : 'hidden'}">
        <div class="autopilot_row">
            <span title="剧情导演每 N 轮介入一次">间隔(轮):</span>
            <input id="autopilot_ext_director_interval" class="text_pole textarea_compact" type="number" min="1" max="50" step="1" value="${settings.directorInterval}" style="width: 60px;" />
        </div>
        <div class="autopilot_row">
            <span title="选择故事类型/主题">类型:</span>
            <select id="autopilot_ext_genre" class="text_pole textarea_compact" style="width: 140px; font-size: 12px;">
                ${genreOptions}
            </select>
        </div>
        <div class="autopilot_row">
            <span title="剧情发展的戏剧程度">强度:</span>
            <select id="autopilot_ext_intensity" class="text_pole textarea_compact" style="width: 120px; font-size: 12px;">
                <option value="low" ${settings.plotIntensity === 'low' ? 'selected' : ''}>低（平缓）</option>
                <option value="medium" ${settings.plotIntensity === 'medium' ? 'selected' : ''}>中（平衡）</option>
                <option value="high" ${settings.plotIntensity === 'high' ? 'selected' : ''}>高（戏剧性）</option>
            </select>
        </div>
        <div class="autopilot_field">
            <span class="autopilot_field_label" title="描述你希望剧情发展的方向">剧情方向/目标:</span>
            <textarea id="autopilot_ext_plot_direction" class="text_pole textarea_compact" rows="2" placeholder="例如：角色们发现了一座隐藏的地下城市..." style="width: 100%; font-size: 12px;">${escapeHtml(settings.plotDirection)}</textarea>
        </div>
        <div class="autopilot_field">
            <span class="autopilot_field_label" title="自定义剧情导演的提示词（高级）">导演提示词（高级）:</span>
            <textarea id="autopilot_ext_director_prompt" class="text_pole textarea_compact" rows="3" placeholder="剧情导演提示词..." style="width: 100%; font-size: 12px;">${escapeHtml(settings.directorPrompt)}</textarea>
        </div>
    </div>

    <div class="autopilot_section_title"><i class="fa-solid fa-users"></i> 角色过滤</div>
    <div id="autopilot_ext_char_list" class="autopilot-char-list">
        <span style="opacity:0.5; font-size:11px;">打开群聊后显示角色列表</span>
    </div>

    <div class="autopilot_section_title"><i class="fa-solid fa-cog"></i> 选项</div>
    <label class="checkbox_label whitespacenowrap" title="打开群聊时自动启动 AutoPilot">
        <input id="autopilot_ext_autostart" type="checkbox" />
        <span>打开群聊时自动启动</span>
    </label>

    <div class="autopilot_stats">
        <span title="自动生成的消息总数">消息数: <span id="autopilot_ext_stat_msgs">${settings.stats.totalMessages}</span></span>
        <span title="剧情导演介入次数">导演介入: <span id="autopilot_ext_stat_dirs">${settings.stats.directorInterventions}</span></span>
    </div>`;
}

function injectExtensionSettings() {
    if (extUiInjected) return;
    if ($('#autopilot_ext_container').length > 0) {
        extUiInjected = true;
        return;
    }

    const html = `
    <div id="autopilot_ext_container" class="extension_container" style="margin-bottom: 10px;">
        <div class="autopilot_ext_header" style="display: flex; align-items: center; justify-content: space-between; padding: 5px 0;">
            <label class="checkbox_label whitespacenowrap" title="启用群聊自动对话">
                <input id="autopilot_ext_toggle" type="checkbox" />
                <span><i class="fa-solid fa-plane-departure"></i> AutoPilot</span>
            </label>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span id="autopilot_ext_status" class="autopilot-status autopilot-off">已停止</span>
                <i id="autopilot_ext_collapse" class="fa-solid fa-chevron-down autopilot-collapse-icon" title="点击展开/折叠设置" style="cursor: pointer; font-size: 14px; padding: 2px 6px;"></i>
            </div>
        </div>
        <div id="autopilot_ext_settings_body" class="extension_settings_body" style="padding: 5px 10px;">
            ${buildSettingsHTML()}
        </div>
    </div>`;

    const target = $('#extensions_settings');
    if (target.length > 0) {
        target.append(html);
        extUiInjected = true;
        bindExtUIEvents();
        syncExtUI();
        refreshCharacterList();
    } else {
        console.warn('[AutoPilot] #extensions_settings not found, will retry...');
    }
}

function injectGroupChatUI() {
    if (uiInjected) return;
    if ($('#autopilot_container').length > 0) {
        uiInjected = true;
        return;
    }

    const html = `
    <div id="autopilot_container" class="autopilot_section">
        <div class="autopilot_header">
            <label class="checkbox_label whitespacenowrap" title="启用自动对话">
                <input id="autopilot_toggle" type="checkbox" />
                <span><i class="fa-solid fa-plane-departure"></i> AutoPilot</span>
            </label>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span id="autopilot_status" class="autopilot-status autopilot-off">已停止</span>
                <i id="autopilot_group_settings" class="fa-solid fa-gear autopilot-group-settings-icon" title="打开 AutoPilot 设置" style="cursor: pointer; font-size: 14px; padding: 2px 6px;"></i>
            </div>
        </div>
    </div>`;

    const target = $('#rm_group_automode_label');
    if (target.length > 0) {
        target.after(html);
        uiInjected = true;
        bindGroupUIEvents();
        syncGroupUI();
    }
}

function bindExtUIEvents() {
    // Toggle button (start/stop)
    $('#autopilot_ext_toggle').off('input').on('input', function () {
        const enabled = $(this).prop('checked');
        if (enabled) {
            startAutoPilot();
        } else {
            stopAutoPilot();
        }
    });

    // Collapse/expand settings via chevron icon
    $('#autopilot_ext_collapse').off('click').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const body = $('#autopilot_ext_settings_body');
        const icon = $(this);
        body.slideToggle(200, function() {
            if (body.is(':visible')) {
                icon.removeClass('fa-chevron-right').addClass('fa-chevron-down');
            } else {
                icon.removeClass('fa-chevron-down').addClass('fa-chevron-right');
            }
        });
    });

    // Pause/Resume button
    $('#autopilot_ext_pause_btn').off('click').on('click', function (e) {
        e.preventDefault();
        togglePause();
    });

    // Next Turn button
    $('#autopilot_ext_next_btn').off('click').on('click', function (e) {
        e.preventDefault();
        triggerNextTurnNow();
    });

    // Director Now button
    $('#autopilot_ext_director_btn').off('click').on('click', function (e) {
        e.preventDefault();
        triggerDirectorNow();
    });

    // Auto-start setting
    $('#autopilot_ext_autostart').off('input').on('input', function () {
        getSettings().autoStart = $(this).prop('checked');
        saveSettings();
    });

    // Delay setting
    $('#autopilot_ext_delay').off('input').on('input', function () {
        const val = Math.max(1, Math.min(120, Number($(this).val()) || 5));
        getSettings().delay = val;
        saveSettings();
        if (isRunning && autopilotTimer) {
            clearInterval(autopilotTimer);
            autopilotTimer = setInterval(autopilotWorker, val * 1000);
        }
    });

    // Max turns setting
    $('#autopilot_ext_max_turns').off('input').on('input', function () {
        const val = Math.max(0, Number($(this).val()) || 0);
        getSettings().maxTurns = val;
        saveSettings();
        updateTurnDisplay();
    });

    // Story Director toggle
    $('#autopilot_ext_director').off('input').on('input', function () {
        const enabled = $(this).prop('checked');
        getSettings().storyDirector = enabled;
        saveSettings();
        if (enabled) {
            $('#autopilot_ext_director_settings').removeClass('hidden');
        } else {
            $('#autopilot_ext_director_settings').addClass('hidden');
        }
    });

    // Director interval
    $('#autopilot_ext_director_interval').off('input').on('input', function () {
        const val = Math.max(1, Math.min(50, Number($(this).val()) || 5));
        getSettings().directorInterval = val;
        saveSettings();
    });

    // Director prompt
    $('#autopilot_ext_director_prompt').off('input').on('input', function () {
        getSettings().directorPrompt = String($(this).val());
        saveSettings();
    });

    // Plot direction
    $('#autopilot_ext_plot_direction').off('input').on('input', function () {
        getSettings().plotDirection = String($(this).val());
        saveSettings();
    });

    // Genre selector
    $('#autopilot_ext_genre').off('change').on('change', function () {
        getSettings().plotGenre = String($(this).val());
        saveSettings();
    });

    // Intensity selector
    $('#autopilot_ext_intensity').off('change').on('change', function () {
        getSettings().plotIntensity = String($(this).val());
        saveSettings();
    });
}

function bindGroupUIEvents() {
    $('#autopilot_toggle').off('input').on('input', function () {
        const enabled = $(this).prop('checked');
        if (enabled) {
            startAutoPilot();
        } else {
            stopAutoPilot();
        }
    });

    // Settings gear button: open Extensions panel and scroll to AutoPilot settings
    $('#autopilot_group_settings').off('click').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        // Open the extensions settings panel
        const extButton = $('#extensions_settings_button');
        if (extButton.length > 0) {
            extButton[0].click();
        }
        // Scroll to AutoPilot container after panel opens
        setTimeout(() => {
            const container = $('#autopilot_ext_container');
            if (container.length > 0) {
                // Make sure settings body is visible
                $('#autopilot_ext_settings_body').slideDown(200);
                $('#autopilot_ext_collapse').removeClass('fa-chevron-right').addClass('fa-chevron-down');
                container[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 400);
    });
}

function syncExtUI() {
    const settings = getSettings();
    $('#autopilot_ext_toggle').prop('checked', isRunning);
    $('#autopilot_ext_autostart').prop('checked', settings.autoStart);
    $('#autopilot_ext_delay').val(settings.delay);
    $('#autopilot_ext_max_turns').val(settings.maxTurns);
    $('#autopilot_ext_director').prop('checked', settings.storyDirector);
    $('#autopilot_ext_director_interval').val(settings.directorInterval);
    $('#autopilot_ext_director_prompt').val(settings.directorPrompt);
    $('#autopilot_ext_plot_direction').val(settings.plotDirection);
    $('#autopilot_ext_genre').val(settings.plotGenre);
    $('#autopilot_ext_intensity').val(settings.plotIntensity);

    if (settings.storyDirector) {
        $('#autopilot_ext_director_settings').removeClass('hidden');
    } else {
        $('#autopilot_ext_director_settings').addClass('hidden');
    }

    updateStatusDisplay();
    updateTurnDisplay();
}

function syncGroupUI() {
    $('#autopilot_toggle').prop('checked', isRunning);
    updateStatusDisplay();
}

function syncAllUI() {
    syncExtUI();
    syncGroupUI();
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== Slash Commands ====================

function registerSlashCommands() {
    const ctx = getContext();
    if (ctx.SlashCommandParser && ctx.SlashCommand) {
        ctx.SlashCommandParser.addCommandObject(
            ctx.SlashCommand.fromProps({
                name: 'autopilot',
                callback: (args, value) => {
                    const action = (value || '').trim().toLowerCase();
                    if (action === 'start' || action === 'on') {
                        if (!isRunning) startAutoPilot();
                        return 'AutoPilot 已启动';
                    } else if (action === 'stop' || action === 'off') {
                        if (isRunning) stopAutoPilot();
                        return 'AutoPilot 已停止';
                    } else if (action === 'pause') {
                        pauseAutoPilot();
                        return 'AutoPilot 已暂停';
                    } else if (action === 'resume') {
                        resumeAutoPilot();
                        return 'AutoPilot 已恢复';
                    } else if (action === 'next') {
                        triggerNextTurnNow();
                        return '正在触发下一轮';
                    } else if (action === 'director') {
                        triggerDirectorNow();
                        return '正在触发剧情导演';
                    } else if (action === 'status') {
                        const s = getSettings();
                        const turns = s.maxTurns > 0 ? `${turnCount}/${s.maxTurns}` : `${turnCount}`;
                        return isRunning ? `AutoPilot 运行中（第 ${turns} 轮）` : 'AutoPilot 已停止';
                    }
                    return '用法: /autopilot [start|stop|pause|resume|next|director|status]';
                },
                helpString: '控制 AutoPilot: /autopilot start|stop|pause|resume|next|director|status',
                returns: '状态信息',
            }),
        );
    }
}

// ==================== Init ====================

export function init() {
    loadSettings();

    // Inject into extensions settings panel (main UI)
    injectExtensionSettings();

    // Also try to inject into group chat panel (quick toggle)
    injectGroupChatUI();

    // Listen for chat changes (group chat opened/closed)
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Also listen for group updates to re-inject UI if needed
    eventSource.on(event_types.GROUP_UPDATED, () => {
        if (!uiInjected || $('#autopilot_container').length === 0) {
            injectGroupChatUI();
        }
        syncAllUI();
        refreshCharacterList();
    });

    // Re-inject UI when app is ready (handles popout windows)
    eventSource.on(event_types.APP_READY, () => {
        injectExtensionSettings();
        injectGroupChatUI();
        syncAllUI();
        refreshCharacterList();
    });

    // Retry injection every 2 seconds for the first 30 seconds (handles slow-loading UI)
    let retries = 0;
    const retryInterval = setInterval(() => {
        if (!extUiInjected) {
            injectExtensionSettings();
        }
        if (!uiInjected) {
            injectGroupChatUI();
        }
        retries++;
        if ((extUiInjected && uiInjected) || retries > 15) {
            clearInterval(retryInterval);
        }
    }, 2000);

    // Periodically update stats display
    setInterval(() => {
        if (extUiInjected) {
            updateTurnDisplay();
        }
    }, 5000);

    registerSlashCommands();

    console.log('[AutoPilot] 扩展已初始化 v3.2.0。在扩展设置中使用 AutoPilot 开关或使用 /autopilot 命令。');
}
