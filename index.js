/**
 * AutoPilot Extension for SillyTavern
 *
 * Features:
 * - Independent auto-dialogue timer for group chats
 * - Story Director: periodically injects plot developments
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
    storyDirector: false,
    directorInterval: 5,
    directorPrompt: DEFAULT_DIRECTOR_PROMPT,
    delay: 5,
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
}

function getSettings() {
    return extension_settings[MODULE_KEY] || defaultSettings;
}

function saveSettings() {
    saveSettingsDebounced();
}

// ==================== Core: AutoPilot Worker ====================

async function autopilotWorker() {
    if (!isRunning) return;

    const ctx = getContext();
    const settings = getSettings();

    // Skip if no connection, not in group, or already generating
    if (ctx.onlineStatus === 'no_connection') return;
    if (!selected_group || is_group_generating) return;

    const group = groups.find((x) => x.id === selected_group);
    if (!group || !Array.isArray(group.members) || !group.members.length) return;

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

    // Update stats
    settings.stats.totalMessages++;
    saveSettings();

    // Story Director intervention
    if (settings.storyDirector) {
        turnCount++;
        if (turnCount >= settings.directorInterval) {
            turnCount = 0;
            await storyDirectorIntervene();
        }
    }
}

// ==================== Story Director ====================

async function storyDirectorIntervene() {
    const ctx = getContext();
    const settings = getSettings();
    const prompt = settings.directorPrompt || DEFAULT_DIRECTOR_PROMPT;

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

// ==================== Start / Stop ====================

function startAutoPilot() {
    if (isRunning) return;
    const settings = getSettings();
    isRunning = true;
    turnCount = 0;

    const delayMs = Math.max(1, settings.delay) * 1000;
    autopilotTimer = setInterval(autopilotWorker, delayMs);

    // Update UI
    $('#autopilot_toggle').prop('checked', true);
    $('#autopilot_ext_toggle').prop('checked', true);
    $('#autopilot_status').removeClass('autopilot-off').addClass('autopilot-on').text('Running');
    $('#autopilot_ext_status').removeClass('autopilot-off').addClass('autopilot-on').text('Running');

    // Stop when generation is manually stopped
    eventSource.once(event_types.GENERATION_STOPPED, () => {
        // Don't stop AutoPilot on generation stop, just abort current
        if (autopilotAbortController) {
            autopilotAbortController.abort();
        }
    });

    toastr.success('AutoPilot engaged! Characters will auto-dialogue.', 'AutoPilot', { timeOut: 3000 });
}

function stopAutoPilot() {
    isRunning = false;
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
    $('#autopilot_status').removeClass('autopilot-on').addClass('autopilot-off').text('Stopped');
    $('#autopilot_ext_status').removeClass('autopilot-on').addClass('autopilot-off').text('Stopped');

    toastr.info('AutoPilot stopped.', 'AutoPilot', { timeOut: 2000 });
}

function toggleAutoPilot() {
    if (isRunning) {
        stopAutoPilot();
    } else {
        startAutoPilot();
    }
}

// ==================== Auto-Start ====================

function onChatChanged() {
    const ctx = getContext();
    const settings = getSettings();

    // Only auto-start for group chats
    if (settings.autoStart && ctx.groupId && !isRunning) {
        // Delay to ensure group is fully loaded
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
}

// ==================== UI Injection ====================

function buildSettingsHTML() {
    const settings = getSettings();
    return `
    <div class="autopilot_row">
        <span title="Delay between auto-dialogue rounds (seconds)">Delay (s):</span>
        <input id="autopilot_ext_delay" class="text_pole textarea_compact" type="number" min="1" max="120" step="1" value="${settings.delay}" style="width: 60px;" />
    </div>
    <label class="checkbox_label whitespacenowrap" title="Automatically start AutoPilot when opening a group chat">
        <input id="autopilot_ext_autostart" type="checkbox" />
        <span>Auto-start on group open</span>
    </label>
    <label class="checkbox_label whitespacenowrap" title="Story Director injects plot developments periodically">
        <input id="autopilot_ext_director" type="checkbox" />
        <span><i class="fa-solid fa-clapperboard"></i> Story Director</span>
    </label>
    <div id="autopilot_ext_director_settings" class="autopilot-director-settings ${settings.storyDirector ? '' : 'hidden'}">
        <div class="autopilot_row">
            <span title="Story Director intervenes every N rounds">Interval (turns):</span>
            <input id="autopilot_ext_director_interval" class="text_pole textarea_compact" type="number" min="1" max="50" step="1" value="${settings.directorInterval}" style="width: 60px;" />
        </div>
        <textarea id="autopilot_ext_director_prompt" class="text_pole textarea_compact" rows="3" placeholder="Story Director prompt..." style="width: 100%; font-size: 12px;">${escapeHtml(settings.directorPrompt)}</textarea>
    </div>
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
        <div class="extension_toggle" style="display: flex; align-items: center; justify-content: space-between; padding: 5px 0;">
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

    // Append to extensions settings panel
    const target = $('#extensions_settings');
    if (target.length > 0) {
        target.append(html);
        extUiInjected = true;
        bindExtUIEvents();
        syncExtUI();
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

    const settings = getSettings();

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

    // Insert after the existing Auto Mode controls
    const target = $('#rm_group_automode_label');
    if (target.length > 0) {
        target.after(html);
        uiInjected = true;
        bindGroupUIEvents();
        syncGroupUI();
    }
}

function bindExtUIEvents() {
    // Toggle button (expand/collapse settings)
    $('#autopilot_ext_toggle').off('input').on('input', function () {
        const enabled = $(this).prop('checked');
        if (enabled) {
            startAutoPilot();
        } else {
            stopAutoPilot();
        }
    });

    // Click header to toggle settings body
    $('#autopilot_ext_container .extension_toggle').off('click').on('click', function (e) {
        if ($(e.target).is('input') || $(e.target).is('span') || $(e.target).is('i')) return;
        $('#autopilot_ext_settings_body').slideToggle();
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
    $('#autopilot_ext_director').prop('checked', settings.storyDirector);
    $('#autopilot_ext_director_interval').val(settings.directorInterval);
    $('#autopilot_ext_director_prompt').val(settings.directorPrompt);
    $('#autopilot_ext_stat_msgs').text(settings.stats.totalMessages);
    $('#autopilot_ext_stat_dirs').text(settings.stats.directorInterventions);

    if (settings.storyDirector) {
        $('#autopilot_ext_director_settings').removeClass('hidden');
    } else {
        $('#autopilot_ext_director_settings').addClass('hidden');
    }

    if (isRunning) {
        $('#autopilot_ext_status').removeClass('autopilot-off').addClass('autopilot-on').text('Running');
    } else {
        $('#autopilot_ext_status').removeClass('autopilot-on').addClass('autopilot-off').text('Stopped');
    }
}

function syncGroupUI() {
    const settings = getSettings();
    $('#autopilot_toggle').prop('checked', isRunning);

    if (isRunning) {
        $('#autopilot_status').removeClass('autopilot-off').addClass('autopilot-on').text('Running');
    } else {
        $('#autopilot_status').removeClass('autopilot-on').addClass('autopilot-off').text('Stopped');
    }
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
                    } else if (action === 'status') {
                        return isRunning ? 'AutoPilot is running' : 'AutoPilot is stopped';
                    } else if (action === 'director') {
                        const settings = getSettings();
                        settings.storyDirector = !settings.storyDirector;
                        saveSettings();
                        syncAllUI();
                        return `Story Director ${settings.storyDirector ? 'enabled' : 'disabled'}`;
                    }
                    return 'Usage: /autopilot [start|stop|status|director]';
                },
                helpString: 'Control AutoPilot: /autopilot start|stop|status|director',
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
    });

    // Re-inject UI when app is ready (handles popout windows)
    eventSource.on(event_types.APP_READY, () => {
        injectExtensionSettings();
        injectGroupChatUI();
        syncAllUI();
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
            const settings = getSettings();
            $('#autopilot_ext_stat_msgs').text(settings.stats.totalMessages);
            $('#autopilot_ext_stat_dirs').text(settings.stats.directorInterventions);
        }
    }, 5000);

    registerSlashCommands();

    console.log('[AutoPilot] Extension initialized. Use the AutoPilot toggle in Extensions settings or /autopilot command.');
}
