// Seule l'origine publique du service figure dans la configuration du site.
const PVVC_WORKER_URL = 'https://pvvc-dictee.medbahnaji44.workers.dev';

(() => {
    const dialog = $('voiceDialog'), transcript = $('voiceText');
    const endpoint = PVVC_WORKER_URL.replace(/\/+$/, '');
    const status = message => { $('voiceStatus').textContent = message; };
    let recorder, stream, timer, blob, audioUrl, request, epoch = 0;
    let busy = false, preview = [], previewRevision, lastBatch, fixture = false;
    const example = [
        'TEST — Coffrage du voile en cours.',
        'Équipe test : 3 personnes présentes.',
        'Livraison de Ciment test : quantité non précisée.'
    ];

    function controls() {
        const recording = !!recorder;
        $('recordVoice').hidden = recording;
        $('stopVoice').hidden = !recording;
        dialog.classList.toggle('recording', recording);
        $('recLabel').textContent = recording ? 'Enregistrement en cours' : 'Microphone au repos';
        for (const id of ['recordVoice','analyzeVoice','loadFixture','correctVoice','retryAudio']) $(id).disabled = busy || recording;
        transcript.readOnly = busy || recording;
        $('analyzeVoice').disabled ||= !transcript.value.trim() || (!endpoint && !fixture);
        $('retryAudio').hidden = !endpoint || !blob;
        $('applyVoice').disabled = busy || recording || !$('voiceChanges').querySelector('input:checked');
    }
    function resetPreview() {
        preview = [];
        $('voiceChanges').replaceChildren();
        controls();
    }
    function releaseMic() {
        clearInterval(timer);
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
    }
    function discardAudio() {
        blob = null;
        $('voicePlayback').pause();
        $('voicePlayback').removeAttribute('src');
        $('voicePlayback').hidden = true;
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = null;
    }
    function endSession() {
        epoch++;
        request?.abort();
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        recorder = null;
        releaseMic();
        discardAudio();
        busy = fixture = false;
        transcript.value = '';
        resetPreview();
        $('recTime').textContent = '00:00';
    }
    $('openVoice').onclick = () => {
        $('voiceMode').textContent = endpoint
            ? 'Mode connecté. Terminer l’enregistrement envoie l’audio à Cloudflare pour transcription et classement.'
            : 'Test local · IA déconnectée. Vous pouvez réécouter le micro ou essayer le remplissage avec un exemple fictif.';
        $('loadFixture').hidden = !!endpoint;
        $('voiceAccessLabel').hidden = !endpoint;
        status('');
        controls();
        dialog.showModal();
    };
    $('closeVoice').onclick = () => dialog.close();
    dialog.addEventListener('close', endSession);
    window.addEventListener('pagehide', () => { if (dialog.open) dialog.close(); endSession(); });

    async function post(path, body, contentType) {
        if (!endpoint.startsWith('https://')) throw new Error('L’adresse du Worker doit commencer par https://.');
        if (!$('voiceAccess').value) throw new Error('Saisissez le code d’accès au Worker.');
        request = new AbortController();
        const controller = request;
        const timeout = setTimeout(() => controller.abort(), 90000);
        try {
            const res = await fetch(endpoint + path, {method:'POST', headers:{'Content-Type':contentType, Authorization:'Bearer ' + $('voiceAccess').value},
                body, signal:controller.signal, credentials:'omit', redirect:'error', referrerPolicy:'no-referrer'});
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || (res.status === 429 ? 'Limite Cloudflare atteinte. Réessayez plus tard.' : 'Le Worker est indisponible (HTTP ' + res.status + ').'));
            if (!data) throw new Error('Réponse illisible du Worker. Réessayez dans un instant.');
            return data;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Le délai de réponse est dépassé. Réessayez avec un extrait plus court.');
            if (e instanceof TypeError) throw new Error('Connexion au Worker impossible. Vérifiez votre réseau et ouvrez le site depuis une adresse autorisée.');
            throw e;
        } finally { clearTimeout(timeout); if (request === controller) request = null; }
    }
    function fixtureResult(fields) {
        // Exemples fixes, indépendants du micro. Une phrase retirée retire sa proposition.
        const changes = [];
        function add(type, evidence, rowLabel, value) {
            if (!transcript.value.includes(evidence)) return;
            let field = fields.find(f => f.type === type);
            if (!field) return;
            if (rowLabel) {
                const existing = fields.find(f => f.type === (type === 'new-person' ? 'count' : 'quantity')
                    && PvVoiceContract.canonical(f.label) === PvVoiceContract.canonical(rowLabel));
                if (existing) { if (!value) return; field = existing; rowLabel = ''; }
            }
            changes.push({fieldId:field.id, evidence, rowLabel, value});
        }
        add('note', example[0], '', example[0]);
        add('new-person', example[1], 'Équipe test', '3');
        add('new-stock', example[2], 'Ciment test', '');
        return {changes};
    }
    $('loadFixture').onclick = () => {
        fixture = true;
        transcript.value = example.join('\n');
        analyze();
    };
    function drawPreview(plan) {
        preview = plan;
        previewRevision = revision;
        $('voiceChanges').replaceChildren();
        plan.forEach(({field, change, before}) => {
            const label = document.createElement('label'), check = document.createElement('input');
            check.type = 'checkbox'; check.checked = true;
            check.onchange = controls;
            const heading = document.createElement('strong');
            heading.textContent = field.section + ' · ' + (change.rowLabel || field.label);
            const value = document.createElement('span'), proof = document.createElement('small');
            const previous = field.type === 'note' ? htmlText(before) : before;
            const next = change.value || 'Quantité laissée vide';
            value.textContent = (field.type.startsWith('new-') ? 'Nouvelle ligne' : 'Actuel : ' + (previous || 'vide'))
                + '\n' + (field.type === 'note' ? 'Texte à ajouter : ' : 'Proposé : ') + next;
            proof.textContent = 'Extrait : « ' + change.evidence + ' »';
            label.append(check, heading, value, proof);
            $('voiceChanges').append(label);
        });
        status(plan.length ? (fixture ? 'Données fictives. ' : '') + 'Cochez les modifications à appliquer au rapport.'
            : 'Aucune proposition applicable. Vérifiez la transcription et les rubriques autorisées.');
        controls();
    }
    async function analyze() {
        const session = epoch, startRevision = revision;
        resetPreview();
        busy = true; controls();
        try {
            const fields = dailyDescriptors(voiceCatalog()), text = transcript.value.trim();
            if (!fields.length) throw new Error('Autorisez la dictée dans une rubrique journalière du formulaire.');
            PvVoiceContract.validateFields(fields);
            if (!text) throw new Error('Renseignez la transcription.');
            status(fixture ? 'Préparation des données de test…' : 'Classement des informations…');
            if (!fixture && !endpoint) throw new Error('Chargez les données de test pour essayer le remplissage.');
            const result = fixture ? fixtureResult(fields) : await post('/analyze', JSON.stringify({transcript:text, fields}), 'application/json');
            if (session !== epoch) return;
            if (revision !== startRevision) throw new Error('Le rapport a changé. Préparez à nouveau les propositions.');
            drawPreview(voicePlan(result, text));
        } catch (e) { if (session === epoch) status(e.message); }
        finally { if (session === epoch) { busy = false; controls(); } }
    }
    async function transcribe() {
        const session = epoch;
        busy = true; controls(); status('Transcription de l’enregistrement…');
        try {
            const data = await post('/transcribe', blob, blob.type);
            if (session !== epoch) return;
            if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('Aucune parole reconnue.');
            const combined = [transcript.value.trim(), data.text.trim()].filter(Boolean).join('\n');
            if (combined.length > 12000) throw new Error('La transcription dépasse 12 000 caractères. Raccourcissez le texte avant de réessayer.');
            transcript.value = combined;
            blob = null; // L’écoute reste disponible, une relance ne peut pas dupliquer le texte.
            await analyze();
        } catch (e) { if (session === epoch) status('Transcription interrompue. ' + e.message); }
        finally { if (session === epoch) { busy = false; controls(); } }
    }
    async function startRecording() {
        const session = epoch;
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            status('Microphone indisponible. Ouvrez le site en HTTPS ou sur localhost, ou utilisez le texte.'); return;
        }
        busy = true; controls(); status('Autorisez l’accès au microphone.');
        try {
            const media = await navigator.mediaDevices.getUserMedia({audio:true});
            if (session !== epoch) { media.getTracks().forEach(t => t.stop()); return; }
            stream = media;
            const mimeType = ['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
            const rec = new MediaRecorder(stream, mimeType ? {mimeType} : undefined);
            const parts = [], started = Date.now();
            let size = 0, failed = false;
            rec.ondataavailable = e => {
                size += e.data.size;
                if (size <= 8 * 1024 ** 2) parts.push(e.data);
                else if (rec.state === 'recording') rec.stop();
            };
            rec.onerror = () => {
                failed = true;
                if (rec.state !== 'inactive') rec.stop();
            };
            rec.onstop = () => {
                if (session !== epoch) return;
                recorder = null; releaseMic();
                if (size > 8 * 1024 ** 2 || !size || failed) {
                    controls(); status('Audio vide, interrompu ou supérieur à 8 Mio. Recommencez avec un extrait plus court.'); return;
                }
                blob = new Blob(parts, {type:rec.mimeType || parts[0].type});
                audioUrl = URL.createObjectURL(blob);
                $('voicePlayback').src = audioUrl; $('voicePlayback').hidden = false;
                controls();
                if (endpoint) transcribe();
                else status('Enregistrement local terminé. Écoutez-le ou chargez les données de test. Aucune transcription automatique en mode local.');
            };
            rec.start(1000); recorder = rec; discardAudio(); resetPreview();
            $('recTime').textContent = '00:00';
            timer = setInterval(() => {
                const seconds = Math.floor((Date.now() - started) / 1000);
                $('recTime').textContent = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2,'0')).join(':');
                if (seconds >= 300 && rec.state === 'recording') rec.stop();
            }, 250);
            status('Enregistrement limité à cinq minutes.');
        } catch (e) {
            if (session === epoch) { releaseMic(); status('Microphone indisponible. Vérifiez le périphérique et son autorisation dans le navigateur.'); }
        } finally { if (session === epoch) { busy = false; controls(); } }
    }
    $('recordVoice').onclick = startRecording;
    $('stopVoice').onclick = () => { if (recorder?.state === 'recording') recorder.stop(); };
    $('retryAudio').onclick = transcribe;
    $('analyzeVoice').onclick = analyze;
    transcript.oninput = () => { resetPreview(); status('Préparez à nouveau les propositions après correction.'); };
    $('correctVoice').onclick = () => {
        resetPreview(); transcript.focus(); transcript.setSelectionRange(transcript.value.length, transcript.value.length);
        status(fixture ? 'Modifiez le texte. Seules les phrases de test conservées produisent une proposition.'
            : 'Complétez le texte ou enregistrez un complément, puis vérifiez les propositions.');
    };
    $('applyVoice').onclick = () => {
        try {
            if (previewRevision !== revision) throw new Error('Le formulaire a changé. Préparez à nouveau les propositions.');
            const selected = [...$('voiceChanges').querySelectorAll('input')].flatMap((el,i) => el.checked ? [preview[i]] : []);
            if (!selected.length) return;
            const plan = voicePlan({changes:selected.map(p => p.change)}, transcript.value.trim());
            if (plan.some((p,i) => p.before !== selected[i].before || p.field.node !== selected[i].field.node)) {
                throw new Error('Un champ a changé. Préparez à nouveau les propositions.');
            }
            lastBatch = writeVoicePlan(plan); markChanged();
            $('undoVoice').hidden = false;
            $('voiceResult').textContent = (fixture ? 'Test · ' : '') + lastBatch.length + ' modification(s) appliquée(s).';
            dialog.close();
        } catch (e) { resetPreview(); status(e.message); }
    };
    $('undoVoice').onclick = () => {
        if (!lastBatch) return;
        const n = undoVoicePlan(lastBatch);
        $('voiceResult').textContent = n + ' modification(s) annulée(s) sur ' + lastBatch.length
            + (n < lastBatch.length ? '. Les champs modifiés depuis ou protégés ont été conservés.' : '.');
        lastBatch = null; $('undoVoice').hidden = true;
    };
})();
