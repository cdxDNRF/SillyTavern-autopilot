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
    'free': 'Free (No theme)',
    'adventure': 'Adventure',
    'romance': 'Romance',
    'mystery': 'Mystery',
    'comedy': 'Comedy',
    'drama': 'Drama',
    'horror': 'Horror',
    'scifi': 'Sci-Fi',
    'fantasy': 'Fantasy',
    'action': 'Action',
    'slice': 'Slice of Life',
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
        toastr.info(`Reached ${settings.maxTurns} turns. AutoPilot stopping.`, 'AutoPilot', { timeOut: 4000 });
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

    toastr.info('Story Director is generating a plot development...', 'AutoPilot', { timeOut: 3000 });

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
            toastr.success(preview + '...', 'Story Director', { timeOut: 5000 });
        }
    } catch (e) {
        console.error('[AutoPilot] Story Director error:', e);
        toastr.warning('Story Director encountered an error.', 'AutoPilot');
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

    const turnsInfo = settings.maxTurns > 0 ? ` (max ${settings.maxTurns} turns)` : ' (unlimited)';
    toastr.success(`AutoPilot engaged!${turnsInfo}`, 'AutoPilot', { timeOut: 3000 });
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

    toastr.info('AutoPilot stopped.', 'AutoPilot', { timeOut: 2000 });
}

function pauseAutoPilot() {
    if (!isRunning || isPaused) return;
    isPaused = true;
    updateStatusDisplay();
    toastr.info('AutoPilot paused.', 'AutoPilot', { timeOut: 2000 });
}

function resumeAutoPilot() {
    if (!isRunning || !isPaused) return;
    isPaused = false;
    updateStatusDisplay();
    toastr.info('AutoPilot resumed.', 'AutoPilot', { timeOut: 2000 });
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
        toastr.warning('Start AutoPilot first.', 'AutoPilot');
        return;
    }
    if (is_group_generating) {
        toastr.warning('Already generating, please wait...', 'AutoPilot');
        return;
    }
    toastr.info('Triggering next turn...', 'AutoPilot', { timeOut: 1500 });
    await autopilotWorker();
}

// Manual trigger: director intervenes now
async function triggerDirectorNow() {
    if (!selected_group) {
        toastr.warning('Open a group chat first.', 'AutoPilot');
        return;
    }
    toastr.info('Story Director intervening now...', 'AutoPilot', { timeOut: 2000 });
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
        container.html('<span style="opacity:0.5; font-size:11px;">Open a group chat to see characters</span>');
        return;
    }

    let html = '';
    // "All characters" option
    html += `<label class="checkbox_label whitespacenowrap" style="font-size:12px;" title="Use all characters in the group">
        <input id="autopilot_ext_char_all" type="checkbox" ${settings.characterFilter.length === 0 ? 'checked' : ''} />
        <span>All Characters</span>
    </label>`;

    // Individual characters
    for (const name of names) {
        const checked = settings.characterFilter.includes(name);
        html += `<label class="checkbox_label whitespacenowrap" style="font-size:12px; margin-left:12px;" title="Include this character in auto-dialogue">
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
    let statusText = 'Stopped';
    let statusClass = 'autopilot-off';

    if (isRunning) {
        if (isPaused) {
            statusText = 'Paused';
            statusClass = 'autopilot-paused';
        } else {
            statusText = 'Running';
            statusClass = 'autopilot-on';
        }
    }

    $('#autopilot_status').removeClass('autopilot-on autopilot-off autopilot-paused').addClass(statusClass).text(statusText);
    $('#autopilot_ext_status').removeClass('autopilot-on autopilot-off autopilot-paused').addClass(statusClass).text(statusText);

    // Update pause button text
    const pauseText = isPaused ? 'Resume' : 'Pause';
    $('#autopilot_ext_pause_btn').text(pauseText);
}

function updateTurnDisplay() {
    const settings = getSettings();
    const maxStr = settings.maxTurns > 0 ? ` / ${settings.maxTurns}` : '';
    const turnStr = `Turn: ${turnCount}${maxStr}`;

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
    <div class="autopilot_section_title"><i class="fa-solid fa-gauge-high"></i> Run Control</div>
    <div class="autopilot_row">
        <span title="Delay between auto-dialogue rounds (seconds)">Delay (s):</span>
        <input id="autopilot_ext_delay" class="text_pole textarea_compact" type="number" min="1" max="120" step="1" value="${settings.delay}" style="width: 60px;" />
        <span title="Maximum turns before auto-stop (0 = unlimited)">Max Turns:</span>
        <input id="autopilot_ext_max_turns" class="text_pole textarea_compact" type="number" min="0" max="9999" step="1" value="${settings.maxTurns}" style="width: 60px;" />
    </div>
    <div class="autopilot_row">
        <span id="autopilot_ext_turn_display" class="autopilot-turn-counter">Turn: 0</span>
    </div>
    <div class="autopilot_button_row">
        <button id="autopilot_ext_pause_btn" class="menu_button menu_button_small" title="Pause/Resume auto-dialogue"><i class="fa-solid fa-pause"></i> Pause</button>
        <button id="autopilot_ext_next_btn" class="menu_button menu_button_small" title="Trigger next turn immediately"><i class="fa-solid fa-forward-step"></i> Next Turn</button>
        <button id="autopilot_ext_director_btn" class="menu_button menu_button_small" title="Trigger Story Director now"><i class="fa-solid fa-clapperboard"></i> Director Now</button>
    </div>

    <div class="autopilot_section_title"><i class="fa-solid fa-clapperboard"></i> Story Director</div>
    <label class="checkbox_label whitespacenowrap" title="Story Director injects plot developments periodically">
        <input id="autopilot_ext_director" type="checkbox" />
        <span>Enable Story Director</span>
    </label>
    <div id="autopilot_ext_director_settings" class="autopilot-director-settings ${settings.storyDirector ? '' : 'hidden'}">
        <div class="autopilot_row">
            <span title="Story Director intervenes every N turns">Interval (turns):</span>
            <input id="autopilot_ext_director_interval" class="text_pole textarea_compact" type="number" min="1" max="50" step="1" value="${settings.directorInterval}" style="width: 60px;" />
        </div>
        <div class="autopilot_row">
            <span title="Select story genre/theme">Genre:</span>
            <select id="autopilot_ext_genre" class="text_pole textarea_compact" style="width: 140px; font-size: 12px;">
                ${genreOptions}
            </select>
        </div>
        <div class="autopilot_row">
            <span title="How dramatic should plot developments be">Intensity:</span>
            <select id="autopilot_ext_intensity" class="text_pole textarea_compact" style="width: 120px; font-size: 12px;">
                <option value="low" ${settings.plotIntensity === 'low' ? 'selected' : ''}>Low (subtle)</option>
                <option value="medium" ${settings.plotIntensity === 'medium' ? 'selected' : ''}>Medium</option>
                <option value="high" ${settings.plotIntensity === 'high' ? 'selected' : ''}>High (dramatic)</option>
            </select>
        </div>
        <div class="autopilot_field">
            <span class="autopilot_field_label" title="Describe where you want the story to go">Plot Direction / Goal:</span>
            <textarea id="autopilot_ext_plot_direction" class="text_pole textarea_compact" rows="2" placeholder="e.g., The characters discover a hidden underground city..." style="width: 100%; font-size: 12px;">${escapeHtml(settings.plotDirection)}</textarea>
        </div>
        <div class="autopilot_field">
            <span class="autopilot_field_label" title="Custom prompt for the Story Director AI">Director Prompt (advanced):</span>
            <textarea id="autopilot_ext_director_prompt" class="text_pole textarea_compact" rows="3" placeholder="Story Director prompt..." style="width: 100%; font-size: 12px;">${escapeHtml(settings.directorPrompt)}</textarea>
        </div>
    </div>

    <div class="autopilot_section_title"><i class="fa-solid fa-users"></i> Character Filter</div>
    <div id="autopilot_ext_char_list" class="autopilot-char-list">
        <span style="opacity:0.5; font-size:11px;">Open a group chat to see characters</span>
    </div>

    <div class="autopilot_section_title"><i class="fa-solid fa-cog"></i> Options</div>
    <label class="checkbox_label whitespacenowrap" title="Automatically start AutoPilot when opening a group chat">
        <input id="autopilot_ext_autostart" type="checkbox" />
        <span>Auto-start on group open</span>
    </label>

    <div class="autopilot_stats">
        <span title="Total auto-generated messages">Messages: <span id="autopilot_ext_stat_msgs">${settings.stats.totalMessages}</span></span>
        <span title="Story Director interventions">Directors: <span id="autopilot_ext_stat_dirs">${settings.stats.directorInterventions}</span></span>
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
        <div class="extension_toggle" style="display: flex; align-items: center; justify-content: space-between; padding: 5px 0; cursor: pointer;">
            <label class="checkbox_label whitespacenowrap" title="Enable AutoPilot auto-dialogue for group chats">
                <input id="autopilot_ext_toggle" type="checkbox" />
                <span><i class="fa-solid fa-plane-departure"></i> AutoPilot</span>
            </label>
            <span id="autopilot_ext_status" class="autopilot-status autopilot-off">Stopped</span>
        </div>
        <div id="autopilot_ext_settings_body" class="extension_settings_body" style="display: none; padding: 5px 10px;">
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
            <label class="checkbox_label whitespacenowrap" title="Enable AutoPilot auto-dialogue">
                <input id="autopilot_toggle" type="checkbox" />
                <span><i class="fa-solid fa-plane-departure"></i> AutoPilot</span>
            </label>
            <span id="autopilot_status" class="autopilot-status autopilot-off">Stopped</span>
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

    // Click header to toggle settings body (but not when clicking the checkbox)
    $('#autopilot_ext_container .extension_toggle').off('click').on('click', function (e) {
        if ($(e.target).is('input') || $(e.target).is('span') || $(e.target).is('i')) return;
        $('#autopilot_ext_settings_body').slideToggle();
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
                        return 'AutoPilot started';
                    } else if (action === 'stop' || action === 'off') {
                        if (isRunning) stopAutoPilot();
                        return 'AutoPilot stopped';
                    } else if (action === 'pause') {
                        pauseAutoPilot();
                        return 'AutoPilot paused';
                    } else if (action === 'resume') {
                        resumeAutoPilot();
                        return 'AutoPilot resumed';
                    } else if (action === 'next') {
                        triggerNextTurnNow();
                        return 'Triggering next turn';
                    } else if (action === 'director') {
                        triggerDirectorNow();
                        return 'Triggering Story Director';
                    } else if (action === 'status') {
                        const s = getSettings();
                        const turns = s.maxTurns > 0 ? `${turnCount}/${s.maxTurns}` : `${turnCount}`;
                        return isRunning ? `AutoPilot running (turn ${turns})` : 'AutoPilot is stopped';
                    }
                    return 'Usage: /autopilot [start|stop|pause|resume|next|director|status]';
                },
                helpString: 'Control AutoPilot: /autopilot start|stop|pause|resume|next|director|status',
                returns: 'status string',
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

    console.log('[AutoPilot] Extension initialized v3.0.0. Use the AutoPilot toggle in Extensions settings or /autopilot command.');
}
