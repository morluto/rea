export function voiceUI(ctx) {
  const { $, esc, modal, toast, action } = ctx;
  let recognition = null,
    mode = null,
    activeBot = null,
    spoken = null,
    busy = false,
    permission = false;
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  let selectedLanguage = 'en-US';
  function stop() {
    mode = null;
    recognition?.abort();
    recognition = null;
    window.speechSynthesis?.cancel();
    busy = false;
    const s = $('#voicestatus');
    if (s) s.textContent = 'Stopped';
  }
  function start(selectedMode) {
    if (!Recognition) throw Error('Speech recognition is unavailable in this browser');
    if (!$('#composer')) throw Error('Open a Bot conversation before starting voice');
    if (!permission) throw Error('Enable the speech-service consent checkbox first');
    recognition?.abort();
    mode = selectedMode;
    activeBot = ctx.botId();
    spoken = ctx
      .history()
      .filter((h) => h.role === 'assistant')
      .at(-1)?.entryId;
    selectedLanguage = $('#voicelanguage')?.value ?? selectedLanguage;
    recognition = new Recognition();
    recognition.lang = selectedLanguage;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onstart = () => {
      const s = $('#voicestatus');
      if (s)
        s.textContent =
          mode === 'conversation' ? 'Listening · conversation' : 'Listening · dictation';
      toast('Microphone listening');
    };
    recognition.onresult = (event) => {
      const text = Array.from(event.results)
        .map((r) => r[0].transcript)
        .join(' ');
      const composer = $('#composer');
      if (composer) composer.value = text;
      if (event.results[event.results.length - 1]?.isFinal && mode === 'conversation') {
        busy = true;
        $('#taskform')?.requestSubmit();
      }
    };
    recognition.onerror = (event) => {
      const s = $('#voicestatus');
      if (s) s.textContent = `Speech error: ${event.error}`;
      toast(`Speech: ${event.error}`);
      if (['not-allowed', 'service-not-allowed'].includes(event.error)) stop();
    };
    recognition.onend = () => {
      recognition = null;
      const s = $('#voicestatus');
      if (s && mode)
        s.textContent = busy
          ? 'Waiting for the Bot response'
          : 'Dictation complete · review before sending';
    };
    recognition.start();
  }
  function open() {
    modal(
      'Voice & dictation',
      `<p class="muted">Dictation fills the composer for review. Voice conversation sends recognized speech as a normal task, reads the completed answer and listens for the next turn.</p><p class="tiny muted">Recognition is provided by your browser and may send audio to its speech service. Orbit has no always-on microphone service and does not store audio. Browser/OS permissions still apply.</p><label class="row"><input type="checkbox" id="speechconsent" style="width:auto" ${permission ? 'checked' : ''}>I agree to use this browser’s speech service</label><label>Speech language</label><select id="voicelanguage"><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="fr-FR">French</option><option value="es-ES">Spanish</option><option value="hi-IN">Hindi</option><option value="zh-CN">Chinese</option></select><p class="tiny muted">Recognition ${Recognition ? 'available' : 'unavailable'} · speech output ${'speechSynthesis' in window ? 'available' : 'unavailable'}</p><div class="row wrap"><button type="button" id="dictate" ${!Recognition ? 'disabled' : ''}>Start dictation</button><button type="button" id="voiceconversation" ${!Recognition ? 'disabled' : ''}>Start voice conversation</button><button type="button" id="stopvoice">Stop microphone & speech</button></div><p id="voicestatus" class="muted" style="margin-top:16px">${mode ? 'Active' : 'Stopped'}</p>`,
    );
    $('#speechconsent').onchange = (e) => {
      permission = e.target.checked;
      if (!permission) stop();
    };
    $('#dictate').onclick = action(() => {
      start('dictation');
      ctx.close();
    });
    $('#voiceconversation').onclick = action(() => {
      start('conversation');
      ctx.close();
    });
    $('#stopvoice').onclick = stop;
  }
  function update() {
    if (!mode) return;
    if (activeBot !== ctx.botId()) {
      stop();
      return;
    }
    if (mode !== 'conversation' || !busy) return;
    const run = ctx
      .overview()
      .runs?.filter((r) => r.conversationId === ctx.conversationId())
      .at(-1);
    if (!run || !['settled', 'failed', 'cancelled', 'interrupted'].includes(run.state)) return;
    const latest = ctx
      .history()
      .filter((h) => h.role === 'assistant')
      .at(-1);
    if (!latest || latest.entryId === spoken) return;
    spoken = latest.entryId;
    const text =
      typeof latest.content === 'string'
        ? latest.content
        : latest.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
    busy = false;
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      // The user may have left the conversation while the answer was spoken;
      // route restart failures through the shared error toast, not an uncaught error.
      if (mode === 'conversation') action(() => start('conversation'))();
    };
    window.speechSynthesis.speak(utterance);
  }
  return { open, update, stop };
}
