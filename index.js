/**
 * AutoPilot Extension for SillyTavern
 *
 * Features:
 * - Auto-dialogue for BOTH group chats AND single character chats
 * - Single chat mode: AI generates {{user}}'s actions, then character responds
 * - Turn limit control (set max turns, auto-stop when reached)
 * - Story Director: periodically injects plot developments
 * - Plot direction control (genre + goal + custom hints)
 * - Character filter (select which characters participate)
 * - Manual trigger buttons (next turn now, director now, pause/resume)
 * - Auto-start when opening chats
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

const DEFAULT_USER_ACTION_PROMPT = [
    'You are the story driver for an ongoing roleplay between {{user}} and {{char}}.',
    'Your task: write {{user}}\'s NEXT action that ADVANCES THE PLOT FORWARD.',
    '',
    'CRITICAL RULES:',
    '1. NEVER repeat or rephrase what already happened in the conversation.',
    '2. NEVER write {{char}}\'s dialogue or actions — only {{user}}\'s.',
    '3. ALWAYS introduce something NEW: a new decision, a question, a physical action, a change of topic, a reaction to something not yet addressed, or moving to a new location/situation.',
    '4. Think about what would naturally happen NEXT to progress the story — then write {{user}} doing it.',
    '5. Do NOT describe the current scene again. Assume the reader already knows what just happened.',
    '6. Write in the same language as the existing chat.',
    '7. Keep it to 1-4 sentences of action/dialogue.',
    '',
    'If the conversation seems stuck or repetitive, BREAK THE PATTERN: introduce a new element, ask a probing question, take an unexpected action, or shift the situation.',
].join('\n');

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
    // Single chat mode
    singleChatMode: 'auto_play', // auto_play: generate {{user}} action + char response; narrative: generate full scene
    userActionPrompt: DEFAULT_USER_ACTION_PROMPT,
    // Character filter (group chat only)
    characterFilter: [],   // empty = all characters; array of character names
    // Plot presets
    plotPresets: [],       // Array of { name, direction, genre, intensity }
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
let singleChatUiInjected = false;

// ==================== Settings ====================

function loadSettings() {
    if (!extension_settings[MODULE_KEY]) {
        extension_settings[MODULE_KEY] = {};
    }
    // Only add missing keys from defaults — do NOT overwrite existing saved settings
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
    // Ensure plotPresets is an array
    if (!Array.isArray(extension_settings[MODULE_KEY].plotPresets)) {
        extension_settings[MODULE_KEY].plotPresets = [];
    }
}

function getSettings() {
    return extension_settings[MODULE_KEY] || defaultSettings;
}

function saveSettings() {
    saveSettingsDebounced();
    // Auto-sync all panels so changes in one panel reflect in all others
    syncAllUI();
}

// ==================== Helper: Detect Chat Mode ====================

function isGroupChat() {
    return !!selected_group;
}

function isSingleChat() {
    const ctx = getContext();
    return !selected_group && ctx.characterId !== undefined && ctx.characterId !== null;
}

function isGenerating() {
    const ctx = getContext();
    if (isGroupChat()) return is_group_generating;
    // For single chat, check if the send button is disabled (generating)
    return $('#send_but').hasClass('displayNone') || ctx.isGenerationInProgress;
}

// ==================== Core: AutoPilot Worker ====================

async function autopilotWorker() {
    if (!isRunning || isPaused) return;

    const ctx = getContext();
    const settings = getSettings();

    // Skip if no connection or already generating
    if (ctx.onlineStatus === 'no_connection') return;
    if (isGenerating()) return;

    // Check turn limit
    if (settings.maxTurns > 0 && turnCount >= settings.maxTurns) {
        toastr.info(`已达到 ${settings.maxTurns} 轮，AutoPilot 自动停止。`, 'AutoPilot', { timeOut: 4000 });
        stopAutoPilot();
        return;
    }

    // Branch: group chat vs single chat
    if (isGroupChat()) {
        await groupChatWorker();
    } else if (isSingleChat()) {
        await singleChatWorker();
    }

    // Update stats and turn count (only if generation happened)
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

// ==================== Group Chat Worker ====================

async function groupChatWorker() {
    const settings = getSettings();
    const group = groups.find((x) => x.id === selected_group);
    if (!group || !Array.isArray(group.members) || !group.members.length) return;

    autopilotAbortController = new AbortController();
    try {
        await generateGroupWrapper(true, 'auto', {
            signal: autopilotAbortController.signal,
        });
    } catch (e) {
        console.debug('[AutoPilot] 群聊生成跳过或中止:', e.message);
    }
}

// ==================== Single Chat Worker ====================

async function singleChatWorker() {
    const ctx = getContext();
    const settings = getSettings();

    if (settings.singleChatMode === 'narrative') {
        // Narrative mode: generate a full scene continuation with both characters
        await singleChatNarrativeMode();
    } else {
        // Auto-play mode: generate {{user}}'s action, then trigger character response
        await singleChatAutoPlayMode();
    }
}

async function singleChatAutoPlayMode() {
    const ctx = getContext();
    const settings = getSettings();

    // Step 1: Generate {{user}}'s next action/dialogue
    const userActionPrompt = buildUserActionPrompt();
    let userAction = '';

    try {
        userAction = await ctx.generateQuietPrompt({
            quietPrompt: userActionPrompt,
            quietToLoud: false,
            skipWIAN: true,
        });
    } catch (e) {
        console.debug('[AutoPilot] 生成用户动作失败:', e.message);
        return;
    }

    if (!userAction || !userAction.trim()) {
        console.debug('[AutoPilot] 用户动作为空，跳过');
        return;
    }

    // Clean up the action text
    userAction = userAction.trim();
    // Remove quotes if the entire text is wrapped in them
    if ((userAction.startsWith('"') && userAction.endsWith('"')) ||
        (userAction.startsWith('"') && userAction.endsWith('"'))) {
        userAction = userAction.slice(1, -1);
    }

    // Step 2: Inject {{user}}'s action as a user message
    const message = {
        name: ctx.name1,
        is_user: true,
        is_system: false,
        mes: userAction,
        send_date: getMessageTimeStamp(),
        extra: {},
        swipe_id: 0,
        swipes: [userAction],
    };

    ctx.chat.push(message);
    ctx.addOneMessage(message);
    await ctx.saveChat();

    // Step 3: Trigger character's response
    try {
        // Use the Generate function to get character's reply
        const Generate = (await import('../../../../script.js')).Generate;
        if (typeof Generate === 'function') {
            await Generate({ trigger: 'autopilot' });
        }
    } catch (e) {
        console.debug('[AutoPilot] 角色回复生成失败:', e.message);
        // Fallback: try clicking the send button
        try {
            const sendButton = $('#send_but:not(.displayNone)');
            if (sendButton.length > 0) {
                sendButton[0].click();
            }
        } catch (e2) {
            console.error('[AutoPilot] 无法触发角色回复:', e2);
        }
    }
}

async function singleChatNarrativeMode() {
    const ctx = getContext();
    const settings = getSettings();

    // Generate a full narrative scene that includes both {{char}} and {{user}}
    const prompt = buildNarrativePrompt();

    let narrative = '';
    try {
        narrative = await ctx.generateQuietPrompt({
            quietPrompt: prompt,
            quietToLoud: false,
            skipWIAN: true,
        });
    } catch (e) {
        console.debug('[AutoPilot] 叙事生成失败:', e.message);
        return;
    }

    if (!narrative || !narrative.trim()) return;

    // Inject as a narrator message
    const narratorText = narrative.trim();
    const message = {
        name: 'Narrator',
        is_user: false,
        is_system: true,
        mes: narratorText,
        send_date: getMessageTimeStamp(),
        extra: { is_system: true },
        swipe_id: 0,
        swipes: [narratorText],
    };

    ctx.chat.push(message);
    ctx.addOneMessage(message);
    await ctx.saveChat();
}

function buildUserActionPrompt() {
    const ctx = getContext();
    const settings = getSettings();
    let prompt = settings.userActionPrompt || DEFAULT_USER_ACTION_PROMPT;

    // Replace macros
    prompt = prompt.replace(/\{\{user\}\}/g, ctx.name1);
    prompt = prompt.replace(/\{\{char\}\}/g, ctx.name2);

    // Add recent context summary to prevent repetition
    const recentMessages = getRecentMessageSummary(5);
    if (recentMessages) {
        prompt += `\n\n--- RECENT CONVERSATION SUMMARY (do NOT repeat these) ---\n${recentMessages}`;
    }

    // Add plot direction if specified
    if (settings.plotDirection && settings.plotDirection.trim()) {
        prompt += `\n\n--- PLOT DIRECTION ---\n${settings.plotDirection.trim()}`;
        prompt += `\nActively steer the story toward this direction. Do not resolve it too quickly — build toward it progressively.`;
    }

    // Add genre if specified
    if (settings.plotGenre && settings.plotGenre !== 'free') {
        const genreName = PLOT_GENRES[settings.plotGenre] || settings.plotGenre;
        prompt += `\n\nGenre: ${genreName}. Make your action fit this genre.`;
    }

    // Add intensity — now focused on story progression, not just "boldness"
    const intensityMap = {
        'low': 'Progression pace: SLOW. Make small, incremental moves. One small step forward.',
        'medium': 'Progression pace: MODERATE. Take a meaningful step that moves the story forward noticeably.',
        'high': 'Progression pace: FAST. Make a significant, decisive move that dramatically changes the situation.',
    };
    prompt += `\n\n${intensityMap[settings.plotIntensity] || intensityMap['medium']}`;

    // Final emphasis
    prompt += '\n\nREMEMBER: Your output must be DIFFERENT from what came before. Introduce NEW content only.';

    return prompt;
}

// Helper: get a brief summary of recent messages to prevent repetition
function getRecentMessageSummary(count) {
    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) return '';

    const recent = ctx.chat.slice(-count);
    const summaries = [];
    for (const msg of recent) {
        const name = msg.is_user ? (ctx.name1 || 'User') : (msg.name || ctx.name2 || 'Character');
        const text = (msg.mes || '').substring(0, 100);
        if (text.trim()) {
            summaries.push(`[${name}]: ${text}${(msg.mes || '').length > 100 ? '...' : ''}`);
        }
    }
    return summaries.join('\n');
}

function buildNarrativePrompt() {
    const ctx = getContext();
    const settings = getSettings();

    let prompt = 'You are a narrative AI advancing an ongoing roleplay story.';
    prompt += `\nWrite the NEXT scene that MOVES THE STORY FORWARD.`;
    prompt += `\nInclude both ${ctx.name2} (the character) and ${ctx.name1} (the user) in the scene.`;
    prompt += `\nWrite their actions, dialogue, and interactions.`;
    prompt += `\nWrite in the same language as the existing chat.`;
    prompt += `\nDo not write more than 3-4 paragraphs.`;

    // Anti-repetition rules
    prompt += `\n\nCRITICAL: Do NOT repeat or rephrase what already happened.`;
    prompt += `\nIntroduce NEW events, decisions, or situations that progress the story.`;
    prompt += `\nIf the story feels stuck, introduce a twist, a new character, a discovery, or a change of scenery.`;

    // Add recent context summary
    const recentMessages = getRecentMessageSummary(5);
    if (recentMessages) {
        prompt += `\n\n--- RECENT CONVERSATION (do NOT repeat these) ---\n${recentMessages}`;
    }

    // Add plot direction
    if (settings.plotDirection && settings.plotDirection.trim()) {
        prompt += `\n\n--- PLOT DIRECTION ---\n${settings.plotDirection.trim()}`;
        prompt += `\nAdvance the story toward this direction. Build toward it progressively.`;
    }

    // Add genre
    if (settings.plotGenre && settings.plotGenre !== 'free') {
        const genreName = PLOT_GENRES[settings.plotGenre] || settings.plotGenre;
        prompt += `\n\nGenre: ${genreName}.`;
    }

    // Add intensity
    const intensityMap = {
        'low': 'Progression pace: SLOW. Gradual, small developments.',
        'medium': 'Progression pace: MODERATE. Meaningful story advancement.',
        'high': 'Progression pace: FAST. Dramatic, impactful scene that significantly changes the story.',
    };
    prompt += `\n\n${intensityMap[settings.plotIntensity] || intensityMap['medium']}`;

    return prompt;
}

// ==================== Story Director ====================

function buildDirectorPrompt() {
    const settings = getSettings();
    let prompt = settings.directorPrompt || DEFAULT_DIRECTOR_PROMPT;

    // Add recent context to avoid repeating events
    const recentMessages = getRecentMessageSummary(6);
    if (recentMessages) {
        prompt += `\n\n--- RECENT CONVERSATION (do NOT repeat these events) ---\n${recentMessages}`;
    }

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

    // Anti-repetition emphasis
    prompt += '\n\nIMPORTANT: Your narrative event must be NEW and DIFFERENT from anything in the recent conversation. Introduce a genuinely new plot element.';

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
            const narratorText = `[旁白] ${direction.trim()}`;

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

    const ctx = getContext();
    const settings = getSettings();

    // Check if we're in a valid chat context
    if (!isGroupChat() && !isSingleChat()) {
        toastr.warning('请先打开一个对话（群聊或角色卡）。', 'AutoPilot');
        return;
    }

    isRunning = true;
    isPaused = false;
    turnCount = 0;

    const delayMs = Math.max(1, settings.delay) * 1000;
    autopilotTimer = setInterval(autopilotWorker, delayMs);

    // Update UI
    $('#autopilot_toggle').prop('checked', true);
    $('#autopilot_ext_toggle').prop('checked', true);
    $('#autopilot_single_toggle').prop('checked', true);
    updateStatusDisplay();

    // Stop when generation is manually stopped
    eventSource.once(event_types.GENERATION_STOPPED, () => {
        if (autopilotAbortController) {
            autopilotAbortController.abort();
        }
    });

    const modeLabel = isGroupChat() ? '群聊' : (settings.singleChatMode === 'narrative' ? '叙事' : '自动扮演');
    const turnsInfo = settings.maxTurns > 0 ? `（最多 ${settings.maxTurns} 轮）` : '（无限轮次）';
    toastr.success(`AutoPilot 已启动！[${modeLabel}模式]${turnsInfo}`, 'AutoPilot', { timeOut: 3000 });
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
    $('#autopilot_single_toggle').prop('checked', false);
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
    if (isGenerating()) {
        toastr.warning('正在生成中，请稍候...', 'AutoPilot');
        return;
    }
    toastr.info('正在触发下一轮...', 'AutoPilot', { timeOut: 1500 });
    await autopilotWorker();
}

// Manual trigger: director intervenes now
async function triggerDirectorNow() {
    const ctx = getContext();
    if (!isGroupChat() && !isSingleChat()) {
        toastr.warning('请先打开一个对话。', 'AutoPilot');
        return;
    }
    toastr.info('剧情导演正在介入...', 'AutoPilot', { timeOut: 2000 });
    await storyDirectorIntervene();
}

// ==================== Auto-Start ====================

function onChatChanged() {
    const ctx = getContext();
    const settings = getSettings();

    // Auto-start for group chats OR single chats
    if (settings.autoStart && !isRunning) {
        const canStart = isGroupChat() || isSingleChat();
        if (canStart) {
            setTimeout(() => {
                if (!isRunning && getContext().onlineStatus !== 'no_connection') {
                    const stillValid = isGroupChat() || isSingleChat();
                    if (stillValid) {
                        startAutoPilot();
                    }
                }
            }, 2000);
        }
    }

    // Stop when leaving all chats
    if (!isGroupChat() && !isSingleChat() && isRunning) {
        stopAutoPilot();
    }

    // Refresh character list when chat changes
    refreshCharacterList();

    // Update mode display
    updateModeDisplay();

    // Refresh inline settings (mode section visibility changes with chat type)
    refreshInlineSettings();
}

// ==================== Character Filter ====================

function getGroupCharacterNames() {
    if (!selected_group) return [];
    const group = groups.find((x) => x.id === selected_group);
    if (!group || !Array.isArray(group.members)) return [];

    const ctx = getContext();
    const names = [];
    for (const memberId of group.members) {
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

    const container = $('#autopilot_ext_char_list');
    if (container.length === 0) return;

    if (!isGroupChat()) {
        container.html('<span style="opacity:0.5; font-size:11px;">仅群聊可用</span>');
        return;
    }

    if (names.length === 0) {
        container.html('<span style="opacity:0.5; font-size:11px;">打开群聊后显示角色列表</span>');
        return;
    }

    let html = '';
    html += `<label class="checkbox_label whitespacenowrap" style="font-size:12px;" title="使用群聊中所有角色">
        <input id="autopilot_ext_char_all" type="checkbox" ${settings.characterFilter.length === 0 ? 'checked' : ''} />
        <span>全部角色</span>
    </label>`;

    for (const name of names) {
        const checked = settings.characterFilter.includes(name);
        html += `<label class="checkbox_label whitespacenowrap" style="font-size:12px; margin-left:12px;" title="选择此角色参与自动对话">
            <input class="autopilot-char-cb" type="checkbox" data-name="${escapeHtml(name)}" ${checked ? 'checked' : ''} />
            <span>${escapeHtml(name)}</span>
        </label>`;
    }
    container.html(html);

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
    $('#autopilot_single_status').removeClass('autopilot-on autopilot-off autopilot-paused').addClass(statusClass).text(statusText);

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

function updateModeDisplay() {
    const settings = getSettings();
    const modeText = isGroupChat()
        ? '群聊模式'
        : (settings.singleChatMode === 'narrative' ? '叙事模式' : '自动扮演模式');
    $('#autopilot_ext_mode_display').text(modeText);

    // Show/hide single chat mode settings
    if (isGroupChat()) {
        $('#autopilot_ext_single_mode_section').addClass('hidden');
        $('#autopilot_ext_char_filter_section').removeClass('hidden');
    } else {
        $('#autopilot_ext_single_mode_section').removeClass('hidden');
        $('#autopilot_ext_char_filter_section').addClass('hidden');
    }
}

// ==================== Inline Settings Panel (for chat area) ====================

function buildInlineSettingsHTML() {
    const settings = getSettings();

    let genreOptions = '';
    for (const [key, label] of Object.entries(PLOT_GENRES)) {
        genreOptions += `<option value="${key}" ${settings.plotGenre === key ? 'selected' : ''}>${label}</option>`;
    }

    // Build preset options
    let presetOptions = '<option value="">-- 选择预设 --</option>';
    if (settings.plotPresets && settings.plotPresets.length > 0) {
        for (const preset of settings.plotPresets) {
            presetOptions += `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`;
        }
    }

    const singleModeSection = isGroupChat() ? 'hidden' : '';
    const groupModeSection = isGroupChat() ? '' : 'hidden';

    return `
    <div class="autopilot_inline_body" style="padding: 8px; display: none;">

        <div class="autopilot_inline_group ${singleModeSection}">
            <div class="autopilot_inline_label">推进方式</div>
            <select id="autopilot_inline_single_mode" class="text_pole textarea_compact autopilot_inline_select">
                <option value="auto_play" ${settings.singleChatMode === 'auto_play' ? 'selected' : ''}>自动扮演</option>
                <option value="narrative" ${settings.singleChatMode === 'narrative' ? 'selected' : ''}>叙事推进</option>
            </select>
        </div>

        <div class="autopilot_inline_row">
            <div class="autopilot_inline_group">
                <div class="autopilot_inline_label">类型</div>
                <select id="autopilot_inline_genre" class="text_pole textarea_compact autopilot_inline_select">
                    ${genreOptions}
                </select>
            </div>
            <div class="autopilot_inline_group">
                <div class="autopilot_inline_label">强度</div>
                <select id="autopilot_inline_intensity" class="text_pole textarea_compact autopilot_inline_select">
                    <option value="low" ${settings.plotIntensity === 'low' ? 'selected' : ''}>低</option>
                    <option value="medium" ${settings.plotIntensity === 'medium' ? 'selected' : ''}>中</option>
                    <option value="high" ${settings.plotIntensity === 'high' ? 'selected' : ''}>高</option>
                </select>
            </div>
        </div>

        <div class="autopilot_inline_group">
            <div class="autopilot_inline_label">剧情方向</div>
            <textarea id="autopilot_inline_plot_direction" class="text_pole textarea_compact autopilot_inline_textarea" rows="2" placeholder="例如：角色们发现了一座隐藏的地下城市...">${escapeHtml(settings.plotDirection)}</textarea>
        </div>

        <div class="autopilot_inline_row">
            <div class="autopilot_inline_group" style="flex:1;">
                <div class="autopilot_inline_label">预设</div>
                <select id="autopilot_inline_preset_select" class="text_pole textarea_compact autopilot_inline_select">
                    ${presetOptions}
                </select>
            </div>
            <button id="autopilot_inline_preset_load" class="menu_button menu_button_small autopilot_inline_btn" title="加载选中的预设">加载</button>
            <button id="autopilot_inline_preset_save" class="menu_button menu_button_small autopilot_inline_btn" title="保存当前剧情方向为新预设">保存</button>
            <button id="autopilot_inline_preset_delete" class="menu_button menu_button_small autopilot_inline_btn" title="删除选中的预设">删除</button>
        </div>

        <div id="autopilot_inline_preset_name_row" class="autopilot_inline_row" style="display:none;">
            <input id="autopilot_inline_preset_name" class="text_pole textarea_compact" type="text" placeholder="输入预设名称..." style="flex:1; font-size:12px;" />
            <button id="autopilot_inline_preset_confirm" class="menu_button menu_button_small autopilot_inline_btn">确认</button>
            <button id="autopilot_inline_preset_cancel" class="menu_button menu_button_small autopilot_inline_btn">取消</button>
        </div>

        <div class="autopilot_inline_row">
            <div class="autopilot_inline_group">
                <div class="autopilot_inline_label">间隔(秒)</div>
                <input id="autopilot_inline_delay" class="text_pole textarea_compact" type="number" min="1" max="120" value="${settings.delay}" style="width:50px; text-align:center;" />
            </div>
            <div class="autopilot_inline_group">
                <div class="autopilot_inline_label">最大轮次</div>
                <input id="autopilot_inline_max_turns" class="text_pole textarea_compact" type="number" min="0" max="9999" value="${settings.maxTurns}" style="width:50px; text-align:center;" />
            </div>
            <label class="checkbox_label whitespacenowrap autopilot_inline_label" title="剧情导演定期注入剧情发展" style="margin-left:8px;">
                <input id="autopilot_inline_director" type="checkbox" ${settings.storyDirector ? 'checked' : ''} />
                <span>剧情导演</span>
            </label>
        </div>

        <div class="autopilot_inline_btn_row">
            <button id="autopilot_inline_pause" class="menu_button menu_button_small autopilot_inline_btn"><i class="fa-solid fa-pause"></i> 暂停</button>
            <button id="autopilot_inline_next" class="menu_button menu_button_small autopilot_inline_btn"><i class="fa-solid fa-forward-step"></i> 下一轮</button>
            <button id="autopilot_inline_director_btn" class="menu_button menu_button_small autopilot_inline_btn"><i class="fa-solid fa-clapperboard"></i> 导演介入</button>
        </div>
    </div>`;
}

function refreshInlineSettings() {
    // Rebuild inline settings HTML in all locations
    const html = buildInlineSettingsHTML();

    // Single chat area
    const singleBody = $('#autopilot_single_container .autopilot_inline_body');
    if (singleBody.length > 0) {
        const wasVisible = singleBody.is(':visible');
        singleBody.replaceWith(html);
        if (wasVisible) {
            $('#autopilot_single_container .autopilot_inline_body').show();
        }
        bindInlineEvents('#autopilot_single_container');
    }

    // Group chat area
    const groupBody = $('#autopilot_container .autopilot_inline_body');
    if (groupBody.length > 0) {
        const wasVisible = groupBody.is(':visible');
        groupBody.replaceWith(html);
        if (wasVisible) {
            $('#autopilot_container .autopilot_inline_body').show();
        }
        bindInlineEvents('#autopilot_container');
    }
}

function bindInlineEvents(containerSelector) {
    const c = containerSelector;

    // Toggle inline settings body
    $(document).off('click', `${c} .autopilot-inline-toggle`).on('click', `${c} .autopilot-inline-toggle`, function (e) {
        e.preventDefault();
        e.stopPropagation();
        const body = $(`${c} .autopilot_inline_body`);
        const icon = $(this);
        body.slideToggle(200, function() {
            if (body.is(':visible')) {
                icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
            } else {
                icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
            }
        });
    });

    // Mode selector
    $(document).off('change', `${c} #autopilot_inline_single_mode`).on('change', `${c} #autopilot_inline_single_mode`, function () {
        getSettings().singleChatMode = String($(this).val());
        saveSettings();
        updateModeDisplay();
    });

    // Genre
    $(document).off('change', `${c} #autopilot_inline_genre`).on('change', `${c} #autopilot_inline_genre`, function () {
        getSettings().plotGenre = String($(this).val());
        saveSettings();
    });

    // Intensity
    $(document).off('change', `${c} #autopilot_inline_intensity`).on('change', `${c} #autopilot_inline_intensity`, function () {
        getSettings().plotIntensity = String($(this).val());
        saveSettings();
    });

    // Plot direction
    $(document).off('input', `${c} #autopilot_inline_plot_direction`).on('input', `${c} #autopilot_inline_plot_direction`, function () {
        getSettings().plotDirection = String($(this).val());
        saveSettings();
    });

    // Delay
    $(document).off('input', `${c} #autopilot_inline_delay`).on('input', `${c} #autopilot_inline_delay`, function () {
        const val = Math.max(1, Math.min(120, Number($(this).val()) || 5));
        getSettings().delay = val;
        saveSettings();
        if (isRunning && autopilotTimer) {
            clearInterval(autopilotTimer);
            autopilotTimer = setInterval(autopilotWorker, val * 1000);
        }
    });

    // Max turns
    $(document).off('input', `${c} #autopilot_inline_max_turns`).on('input', `${c} #autopilot_inline_max_turns`, function () {
        const val = Math.max(0, Number($(this).val()) || 0);
        getSettings().maxTurns = val;
        saveSettings();
    });

    // Story Director toggle
    $(document).off('input', `${c} #autopilot_inline_director`).on('input', `${c} #autopilot_inline_director`, function () {
        getSettings().storyDirector = $(this).prop('checked');
        saveSettings();
    });

    // Pause button
    $(document).off('click', `${c} #autopilot_inline_pause`).on('click', `${c} #autopilot_inline_pause`, function (e) {
        e.preventDefault();
        togglePause();
    });

    // Next turn button
    $(document).off('click', `${c} #autopilot_inline_next`).on('click', `${c} #autopilot_inline_next`, function (e) {
        e.preventDefault();
        triggerNextTurnNow();
    });

    // Director now button
    $(document).off('click', `${c} #autopilot_inline_director_btn`).on('click', `${c} #autopilot_inline_director_btn`, function (e) {
        e.preventDefault();
        triggerDirectorNow();
    });

    // Preset: load
    $(document).off('click', `${c} #autopilot_inline_preset_load`).on('click', `${c} #autopilot_inline_preset_load`, function (e) {
        e.preventDefault();
        const presetName = $(`${c} #autopilot_inline_preset_select`).val();
        if (!presetName) {
            toastr.warning('请先选择一个预设。', 'AutoPilot');
            return;
        }
        loadPreset(presetName, c);
    });

    // Preset: save (show name input)
    $(document).off('click', `${c} #autopilot_inline_preset_save`).on('click', `${c} #autopilot_inline_preset_save`, function (e) {
        e.preventDefault();
        $(`${c} #autopilot_inline_preset_name_row`).slideDown(200);
        $(`${c} #autopilot_inline_preset_name`).focus();
    });

    // Preset: confirm save
    $(document).off('click', `${c} #autopilot_inline_preset_confirm`).on('click', `${c} #autopilot_inline_preset_confirm`, function (e) {
        e.preventDefault();
        const name = $(`${c} #autopilot_inline_preset_name`).val().trim();
        if (!name) {
            toastr.warning('请输入预设名称。', 'AutoPilot');
            return;
        }
        savePreset(name);
        $(`${c} #autopilot_inline_preset_name`).val('');
        $(`${c} #autopilot_inline_preset_name_row`).slideUp(200);
    });

    // Preset: cancel save
    $(document).off('click', `${c} #autopilot_inline_preset_cancel`).on('click', `${c} #autopilot_inline_preset_cancel`, function (e) {
        e.preventDefault();
        $(`${c} #autopilot_inline_preset_name`).val('');
        $(`${c} #autopilot_inline_preset_name_row`).slideUp(200);
    });

    // Preset: delete
    $(document).off('click', `${c} #autopilot_inline_preset_delete`).on('click', `${c} #autopilot_inline_preset_delete`, function (e) {
        e.preventDefault();
        const presetName = $(`${c} #autopilot_inline_preset_select`).val();
        if (!presetName) {
            toastr.warning('请先选择一个预设。', 'AutoPilot');
            return;
        }
        deletePreset(presetName);
    });
}

// ==================== Plot Presets ====================

function savePreset(name) {
    const settings = getSettings();
    if (!Array.isArray(settings.plotPresets)) {
        settings.plotPresets = [];
    }

    // Check if preset with same name exists, update it
    const existing = settings.plotPresets.find(p => p.name === name);
    if (existing) {
        existing.direction = settings.plotDirection;
        existing.genre = settings.plotGenre;
        existing.intensity = settings.plotIntensity;
        existing.singleChatMode = settings.singleChatMode;
    } else {
        settings.plotPresets.push({
            name: name,
            direction: settings.plotDirection,
            genre: settings.plotGenre,
            intensity: settings.plotIntensity,
            singleChatMode: settings.singleChatMode,
        });
    }

    // saveSettings() calls syncAllUI() which refreshes preset dropdowns
    saveSettings();
    toastr.success(`预设「${name}」已保存`, 'AutoPilot', { timeOut: 2000 });
}

function loadPreset(name, containerSelector) {
    const settings = getSettings();
    const preset = settings.plotPresets.find(p => p.name === name);
    if (!preset) {
        toastr.warning(`找不到预设「${name}」`, 'AutoPilot');
        return;
    }

    settings.plotDirection = preset.direction || '';
    settings.plotGenre = preset.genre || 'free';
    settings.plotIntensity = preset.intensity || 'medium';
    if (preset.singleChatMode) {
        settings.singleChatMode = preset.singleChatMode;
    }
    // saveSettings() calls syncAllUI() which updates ALL panels
    saveSettings();

    toastr.success(`预设「${name}」已加载`, 'AutoPilot', { timeOut: 2000 });
}

function deletePreset(name) {
    const settings = getSettings();
    if (!Array.isArray(settings.plotPresets)) return;

    const idx = settings.plotPresets.findIndex(p => p.name === name);
    if (idx < 0) {
        toastr.warning(`找不到预设「${name}」`, 'AutoPilot');
        return;
    }

    settings.plotPresets.splice(idx, 1);
    // saveSettings() calls syncAllUI() which refreshes preset dropdowns
    saveSettings();
    toastr.info(`预设「${name}」已删除`, 'AutoPilot', { timeOut: 2000 });
}

function syncPresetSelects() {
    const settings = getSettings();
    let presetOptions = '<option value="">-- 选择预设 --</option>';
    if (settings.plotPresets && settings.plotPresets.length > 0) {
        for (const preset of settings.plotPresets) {
            presetOptions += `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`;
        }
    }
    $('#autopilot_inline_preset_select').html(presetOptions);
}

// ==================== UI Injection ====================

function buildSettingsHTML() {
    const settings = getSettings();

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
        <span id="autopilot_ext_mode_display" class="autopilot-mode-tag">--</span>
    </div>
    <div class="autopilot_button_row">
        <button id="autopilot_ext_pause_btn" class="menu_button menu_button_small" title="暂停/恢复自动对话"><i class="fa-solid fa-pause"></i> 暂停</button>
        <button id="autopilot_ext_next_btn" class="menu_button menu_button_small" title="立即触发下一轮对话"><i class="fa-solid fa-forward-step"></i> 下一轮</button>
        <button id="autopilot_ext_director_btn" class="menu_button menu_button_small" title="立即触发剧情导演"><i class="fa-solid fa-clapperboard"></i> 导演介入</button>
    </div>

    <div id="autopilot_ext_single_mode_section" class="${isGroupChat() ? 'hidden' : ''}">
        <div class="autopilot_section_title"><i class="fa-solid fa-user-pen"></i> 单聊模式</div>
        <div class="autopilot_row">
            <span title="选择单角色卡的自动推进方式">推进方式:</span>
            <select id="autopilot_ext_single_mode" class="text_pole textarea_compact" style="width: 130px; font-size: 12px;">
                <option value="auto_play" ${settings.singleChatMode === 'auto_play' ? 'selected' : ''}>自动扮演</option>
                <option value="narrative" ${settings.singleChatMode === 'narrative' ? 'selected' : ''}>叙事推进</option>
            </select>
        </div>
        <div class="autopilot_field">
            <span class="autopilot_field_label" title="AI 扮演 {{user}} 时的提示词（自动扮演模式）">用户扮演提示词:</span>
            <textarea id="autopilot_ext_user_prompt" class="text_pole textarea_compact" rows="3" placeholder="用户扮演提示词..." style="width: 100%; font-size: 12px;">${escapeHtml(settings.userActionPrompt)}</textarea>
        </div>
        <div style="font-size:11px; opacity:0.6; margin-left:8px; margin-bottom:4px;">
            <b>自动扮演</b>: AI 先生成你的行动，再触发角色回复<br/>
            <b>叙事推进</b>: AI 直接生成包含双方的场景叙事
        </div>
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

    <div id="autopilot_ext_char_filter_section" class="${isGroupChat() ? '' : 'hidden'}">
        <div class="autopilot_section_title"><i class="fa-solid fa-users"></i> 角色过滤</div>
        <div id="autopilot_ext_char_list" class="autopilot-char-list">
            <span style="opacity:0.5; font-size:11px;">打开群聊后显示角色列表</span>
        </div>
    </div>

    <div class="autopilot_section_title"><i class="fa-solid fa-cog"></i> 选项</div>
    <label class="checkbox_label whitespacenowrap" title="打开对话时自动启动 AutoPilot">
        <input id="autopilot_ext_autostart" type="checkbox" />
        <span>打开对话时自动启动</span>
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
            <label class="checkbox_label whitespacenowrap" title="启用自动对话/剧情推进">
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
        updateModeDisplay();
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
                <i class="fa-solid fa-chevron-down autopilot-inline-toggle autopilot-collapse-icon" title="点击展开/折叠设置" style="cursor: pointer; font-size: 14px; padding: 2px 6px;"></i>
            </div>
        </div>
        ${buildInlineSettingsHTML()}
    </div>`;

    const target = $('#rm_group_automode_label');
    if (target.length > 0) {
        target.after(html);
        uiInjected = true;
        bindGroupUIEvents();
        bindInlineEvents('#autopilot_container');
        syncGroupUI();
    }
}

function injectSingleChatUI() {
    if (singleChatUiInjected) return;
    if ($('#autopilot_single_container').length > 0) {
        singleChatUiInjected = true;
        return;
    }

    const html = `
    <div id="autopilot_single_container" class="autopilot_section" style="margin-top: 5px; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 5px; background: rgba(0, 0, 0, 0.15);">
        <div class="autopilot_header">
            <label class="checkbox_label whitespacenowrap" title="启用自动剧情推进">
                <input id="autopilot_single_toggle" type="checkbox" />
                <span><i class="fa-solid fa-plane-departure"></i> AutoPilot</span>
            </label>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span id="autopilot_single_status" class="autopilot-status autopilot-off">已停止</span>
                <i class="fa-solid fa-chevron-down autopilot-inline-toggle autopilot-collapse-icon" title="点击展开/折叠设置" style="cursor: pointer; font-size: 14px; padding: 2px 6px;"></i>
            </div>
        </div>
        ${buildInlineSettingsHTML()}
    </div>`;

    // Inject near the send button / form area for single chats
    let target = $('#send_form .options_button');
    if (target.length === 0) {
        target = $('#rightSendForm .options_button');
    }
    if (target.length === 0) {
        target = $('#send_form');
        if (target.length > 0) {
            target.after(html);
            singleChatUiInjected = true;
            bindSingleChatUIEvents();
            bindInlineEvents('#autopilot_single_container');
            syncSingleChatUI();
            return;
        }
    }
    if (target.length === 0) {
        target = $('#right-nav-panel .fa-paper-plane').parent();
    }
    if (target.length > 0) {
        target.first().after(html);
        singleChatUiInjected = true;
        bindSingleChatUIEvents();
        bindInlineEvents('#autopilot_single_container');
        syncSingleChatUI();
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

    // Single chat mode selector
    $('#autopilot_ext_single_mode').off('change').on('change', function () {
        getSettings().singleChatMode = String($(this).val());
        saveSettings();
        updateModeDisplay();
    });

    // User action prompt
    $('#autopilot_ext_user_prompt').off('input').on('input', function () {
        getSettings().userActionPrompt = String($(this).val());
        saveSettings();
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
    // Use document-level delegation so events survive DOM re-renders
    $(document).off('input', '#autopilot_toggle').on('input', '#autopilot_toggle', function () {
        const enabled = $(this).prop('checked');
        if (enabled) {
            startAutoPilot();
        } else {
            stopAutoPilot();
        }
    });
}

function bindSingleChatUIEvents() {
    // Use document-level delegation so events survive DOM re-renders
    $(document).off('input', '#autopilot_single_toggle').on('input', '#autopilot_single_toggle', function () {
        const enabled = $(this).prop('checked');
        if (enabled) {
            startAutoPilot();
        } else {
            stopAutoPilot();
        }
    });
}

function syncExtUI() {
    const settings = getSettings();
    $('#autopilot_ext_toggle').prop('checked', isRunning);
    $('#autopilot_ext_autostart').prop('checked', settings.autoStart);
    $('#autopilot_ext_delay').val(settings.delay);
    $('#autopilot_ext_max_turns').val(settings.maxTurns);
    $('#autopilot_ext_single_mode').val(settings.singleChatMode);
    $('#autopilot_ext_user_prompt').val(settings.userActionPrompt);
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
    updateModeDisplay();
}

// Sync inline panel elements (in both group chat and single chat containers)
function syncInlineUI() {
    const settings = getSettings();

    // Update inline elements in all containers
    const selectors = ['#autopilot_container', '#autopilot_single_container'];
    for (const c of selectors) {
        if ($(c).length === 0) continue;

        $(`${c} #autopilot_inline_single_mode`).val(settings.singleChatMode);
        $(`${c} #autopilot_inline_genre`).val(settings.plotGenre);
        $(`${c} #autopilot_inline_intensity`).val(settings.plotIntensity);
        $(`${c} #autopilot_inline_plot_direction`).val(settings.plotDirection);
        $(`${c} #autopilot_inline_delay`).val(settings.delay);
        $(`${c} #autopilot_inline_max_turns`).val(settings.maxTurns);
        $(`${c} #autopilot_inline_director`).prop('checked', settings.storyDirector);
    }

    // Sync preset dropdowns
    syncPresetSelects();

    updateStatusDisplay();
    updateTurnDisplay();
    updateModeDisplay();
}

function syncGroupUI() {
    $('#autopilot_toggle').prop('checked', isRunning);
    updateStatusDisplay();
}

function syncSingleChatUI() {
    $('#autopilot_single_toggle').prop('checked', isRunning);
    updateStatusDisplay();
}

// Master sync: updates ALL panels (ext + inline + toggles)
function syncAllUI() {
    syncExtUI();
    syncInlineUI();
    syncGroupUI();
    syncSingleChatUI();
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
                        const mode = isGroupChat() ? '群聊' : (s.singleChatMode === 'narrative' ? '叙事' : '自动扮演');
                        return isRunning ? `AutoPilot 运行中 [${mode}]（第 ${turns} 轮）` : 'AutoPilot 已停止';
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

    // Inject into group chat panel (quick toggle)
    injectGroupChatUI();

    // Inject into single chat area (quick toggle)
    injectSingleChatUI();

    // Listen for chat changes
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Also listen for group updates
    eventSource.on(event_types.GROUP_UPDATED, () => {
        if (!uiInjected || $('#autopilot_container').length === 0) {
            injectGroupChatUI();
        }
        syncAllUI();
        refreshCharacterList();
        updateModeDisplay();
    });

    // Listen for character message rendered (to catch single chat loads)
    eventSource.on(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, () => {
        syncAllUI();
        updateModeDisplay();
        refreshCharacterList();
    });

    // Re-inject UI when app is ready
    eventSource.on(event_types.APP_READY, () => {
        injectExtensionSettings();
        injectGroupChatUI();
        injectSingleChatUI();
        syncAllUI();
        refreshCharacterList();
        updateModeDisplay();
    });

    // Retry injection every 2 seconds for the first 30 seconds
    let retries = 0;
    const retryInterval = setInterval(() => {
        if (!extUiInjected) {
            injectExtensionSettings();
        }
        if (!uiInjected) {
            injectGroupChatUI();
        }
        if (!singleChatUiInjected) {
            injectSingleChatUI();
        }
        retries++;
        if ((extUiInjected && uiInjected && singleChatUiInjected) || retries > 15) {
            clearInterval(retryInterval);
        }
    }, 2000);

    // Periodically update stats display and mode
    setInterval(() => {
        if (extUiInjected) {
            updateTurnDisplay();
            updateModeDisplay();
        }
    }, 5000);

    registerSlashCommands();

    console.log('[AutoPilot] 扩展已初始化 v4.0.0。支持群聊和单角色卡对话。在扩展设置中使用 AutoPilot 开关或使用 /autopilot 命令。');
}
