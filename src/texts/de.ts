// German mirror of en.ts.

import type { Texts } from './en.js';

export const de: Texts = {
  list: (items) => {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1] ?? ''}`;
  },

  echoRecorded: (name, summary) => `Für dich erfasst, ${name}: ${summary}`,
  questionnaireAnswered: (name, answered, of, changed) => `Antwort von ${name} ${changed ? 'geändert' : 'erfasst'} (${String(answered)} von ${String(of)})`,
  questionnaireNoAnswer: 'keine Antwort',
  echoInterpreted: (name, summary) =>
    `${name}, ich habe deine Nachricht so verstanden: ${summary}. Antworte mit "ja" (oder reagiere mit 👍), um zu bestätigen, oder korrigiere mich. Es zählt, sobald du bestätigt hast.`,
  echoUnverifiedCard: (name, summary) =>
    `${name}, auf der Karte kam eine Antwort unter deinem Namen an, und der Kanal konnte nicht bestätigen, dass sie von dir ist: ${summary}. Antworte mit "ja" (oder reagiere mit 👍), um zu bestätigen, oder korrigiere mich. Es zählt, sobald du bestätigt hast.`,
  echoChanged: (name, summary) => `Für dich geändert, ${name}: ${summary}`,
  echoConfirmed: (name, summary) => `Bestätigt, ${name}: ${summary}`,
  echoDeclined: (name) => `Verstanden, ${name}: Ich habe das nicht erfasst.`,
  echoWithdrawn: (name) => `${name}, du hast deine Nachricht gelöscht, deshalb habe ich den Beitrag daraus zurückgezogen.`,
  whichConfirmation: (name, open) =>
    `${name}, mehrere Dinge warten auf deine Bestätigung. Antworte bitte direkt auf das, was du meinst:\n${open.map((o) => `- ${o}`).join('\n')}`,

  stopped: (name) => `${name} hat um Stopp gebeten. Die Moderation endet hier ohne Ergebnis. Es wird nichts weiter gesendet.`,
  aborted: (reason) => `Diese Moderation endet ohne Ergebnis. Grund: ${reason}`,

  card: {
    chatToo: 'Eine Antwort im Chat zählt auch; eure neueste Antwort zählt.',
    stepOf: (position, total) => `Schritt ${String(position)} von ${String(total)}.`,
    voteOnCard: 'Abgestimmt wird über die Karte; eine Antwort im Chat zählt auch.',
    rank: 'Reiht die Optionen, die beste zuerst.',
    rankLabel: (rank, points) => (points === undefined ? `${String(rank)}. Platz` : `${String(rank)}. Platz (${String(points)} ${points === 1 ? 'Punkt' : 'Punkte'})`),
    single: 'Wählt eine Option.',
    approval: 'Wählt alle Optionen, mit denen ihr mitgehen könnt.',
    idea: 'Deine Idee (eine pro Absenden)',
    superseded: 'Ersetzt durch eine neue Version dieser Abstimmung. Bitte auf der neuen Karte antworten.',
    supersededQuestionnaire: 'Ersetzt durch einen neuen Fragebogen. Bitte auf der neuen Karte antworten.',
    closed: (when) => `Geschlossen am ${when}.`,
    numberExpected: (min, max) =>
      `Nur eine Zahl, z. B. 15${min !== undefined && max !== undefined ? `, zwischen ${String(min)} und ${String(max)}` : min !== undefined ? `, mindestens ${String(min)}` : max !== undefined ? `, höchstens ${String(max)}` : ''}.`,
    dateExpected: 'Ein Datum, z. B. 24.11.2026 oder 2026-11-24.',
    notAsExpected: (label, expected) => `Deine Antwort auf „${label}“ konnte ich nicht verwenden. Ich brauche: ${expected.charAt(0).toLowerCase()}${expected.slice(1)} Bitte antworte noch einmal auf der Karte; von dieser Abgabe wurde nichts erfasst.`,
  },

  unnamedPerson: 'Teilnehmer:in ohne Namen',
  someone: 'jemand aus dieser Runde',

  joined: (name, goal) =>
    `Willkommen, ${name}. Diese Unterhaltung wird moderiert. Ziel: ${goal}. Du zählst ab jetzt als Teilnehmende:r; frag nach dem "Status", um zu sehen, wo wir stehen.`,
  left: (name) => `${name} hat die Unterhaltung verlassen. Die bisherigen Beiträge bleiben gezählt.`,
  initiatorLeft: (name) =>
    `${name} hat diese Moderation gestartet und die Unterhaltung verlassen. Ab jetzt erhält ${name} weder weitere Beiträge noch den Bericht.`,

  words: { abstention: 'Enthaltung', consent: 'Zustimmung', objection: 'Einwand', declined: 'abgelehnt' },

  options: (options) => options.map((o) => `${o.key} = ${o.label}`).join(', '),

  rules: {
    ranked: (options, points) =>
      `So stimmt ihr ab: Reiht die Optionen, die beste zuerst, z. B. "A > C > B". Optionen: ${options}. Punkte pro Rang: ${points.join('/')}; eine Teilreihung ist in Ordnung, ausgelassene Ränge zählen 0.`,
    single: (options) => `So stimmt ihr ab: Schreibt die eine Option, die ihr wählt, z. B. "B". Optionen: ${options}.`,
    approval: (options) => `So stimmt ihr ab: Schreibt alle Optionen, denen ihr zustimmt, z. B. "A, C". Optionen: ${options}.`,
    consent: (statement) =>
      `Vorschlag: ${statement}. Schreibt "einverstanden", wenn ihr mitgehen könnt, oder "Einwand: <euer Grund>". Er gilt, wenn kein Einwand steht.`,
    assignment: (items) =>
      `Zu vergeben: ${items}. Übernehmt etwas mit "Ich übernehme A" oder schlagt jemanden vor mit "A: Name". Ein Name zählt erst, wenn die Person selbst Ja gesagt hat.`,
    common: (closeRule) =>
      `"Enthaltung" zählt als Beitrag. Ihr könnt euren Beitrag ändern, ${closeRule === 'at_deadline' ? 'bis zur Deadline' : 'bis alle beigetragen haben'}: schreibt einen neuen oder bearbeitet eure Nachricht. Alle Beiträge sind offen. Bei Gleichstand gibt es eine Stichwahl unter den gleichauf liegenden Optionen.`,
  },

  hint: {
    duplicate_option: (detail) => `eine Option kommt doppelt vor (${detail}). Bitte nenne jede Option nur einmal.`,
    duplicate_rank: (detail) => `ein Rang ist doppelt vergeben (${detail}). Bitte gib jeder Option einen eigenen Rang.`,
    bad_rank: (detail) => `die Ränge müssen lückenlos 1, 2, 3 lauten (du hast ${detail} geschrieben).`,
    unknown_option: (detail) => `diese Option kenne ich nicht: ${detail}. Welche der Optionen meinst du?`,
    too_many_options: (detail) => `hier zählt genau eine Option (du hast ${detail} genannt). Welche?`,
    reason_required: () => `ein Einwand braucht seinen Grund: "Einwand: <Grund>". Was ist deiner?`,
    unknown_person: (detail) => `ich kann "${detail}" keiner teilnehmenden Person zuordnen. Wen meinst du?`,
    ambiguous_person: (detail) => `"${detail}" passt auf mehrere Teilnehmende. Bitte nimm den vollen Namen.`,
  },

  nominated: (nominee, by, item) =>
    `${nominee}, ${by} schlägt dich für ${item} vor. Antworte hier in der Gruppe mit "ja", um zu übernehmen, oder mit "nein", um abzulehnen.`,
  nominationAccepted: (nominee, item) => `${nominee} übernimmt ${item}.`,
  nominationDeclined: (nominee, item) => `${nominee} hat ${item} abgelehnt. Es ist wieder offen.`,
  itemTaken: (name, item, holder) => `${name}, ${item} ist bereits an ${holder} vergeben.`,

  runoff: (tied, until) =>
    `Die Abstimmung endete gleichauf zwischen ${tied}. Stichwahl unter diesen, gleiche Methode, bis ${until}. Bitte stimmt noch einmal ab.`,
  notInRunoff: (name, options) => `${name}, die Stichwahl läuft nur zwischen ${options}. Bitte wähle unter diesen.`,
  objectionStands: (objections) =>
    `Es steht ein Einwand, der Vorschlag gilt also noch nicht:\n${objections.map((o) => `- ${o}`).join('\n')}\nSchauen wir, was ihn tragfähig machen würde.`,
  putAgain: (statement) => `Geänderter Vorschlag: ${statement}. Schreibt "einverstanden" oder "Einwand: <euer Grund>".`,

  decided: {
    winner: (title, option, scores) => `${title}: ${option} (${scores})`,
    consent: (statement) => `Im Konsent beschlossen: ${statement}`,
    assignment: (title, pairs) => `${title}: ${pairs}`,
  },

  result: (r) =>
    [
      `Ergebnis zu "${r.goal}":`,
      ...r.decisions.map((d) => `- ${d}`),
      ...(r.answers && r.answers.length > 0 ? ['Antworten:', ...r.answers.map((a) => `- ${a}`)] : []),
      ...(r.unanswered !== undefined ? [`Auf den Fragebogen "${r.unanswered}" hat niemand geantwortet, deshalb gibt es keine Antworten zu berichten.`] : []),
      ...(r.actions && r.actions.length > 0 ? ['Nächste Schritte:', ...r.actions.map((a) => `- ${a}`)] : []),
      ...(r.open && r.open.length > 0 ? ['Offene Punkte:', ...r.open.map((o) => `- ${o}`)] : []),
      ...(r.atDeadline ? [`Die Deadline ist erreicht; ${String(r.atDeadline.contributed)} von ${String(r.atDeadline.of)} haben beigetragen, und dies ist das Ergebnis der abgegebenen Beiträge.`] : []),
      'Diese Moderation ist abgeschlossen. Danke euch.',
    ].join('\n'),
  abortTie: (tied) => `die Deadline ist erreicht und die Abstimmung steht gleichauf zwischen ${tied}`,
  abortObjection: (objections) => `die Deadline ist erreicht und es steht ein Einwand (${objections})`,
  abortOpenItems: (items) => `die Deadline ist erreicht und Folgendes ist noch offen: ${items}`,
  abortNoVotes: () => 'die Deadline ist erreicht und niemand hat abgestimmt',
  abortOnlyAbstentions: () => 'die Deadline ist erreicht und niemand hat für eine Option gestimmt',
  abortNothing: () => 'die Deadline ist erreicht und die Definition of Done ist nicht erfüllt',

  reminderGroup: (open, deadline) =>
    `Erinnerung: ${open === 1 ? 'Ein Beitrag ist' : `${String(open)} Beiträge sind`} noch offen.${deadline ? ` Deadline: ${deadline}.` : ''} Fragt nach dem "Status" für die Details.`,
  reminderGroupOpen: (deadline) => `Erinnerung: Diese Abstimmung läuft${deadline ? ` noch bis ${deadline}` : ' noch'}. Wer noch nicht beigetragen hat, kann das jetzt tun.`,
  reminderDirect: (name, goal, deadline) =>
    `Hallo ${name}, dein Beitrag zu "${goal}" ist noch offen.${deadline ? ` Deadline: ${deadline}.` : ''} Bitte antworte in der Gruppe; hier kann ich keine Beiträge annehmen.`,
  directUnreachable: () =>
    'Ich kann hier nicht alle privat erreichen (meine App ist nicht bei allen installiert). Erinnerungen bleiben deshalb in dieser Gruppe, ohne Namen.',
  abortJobFailed: () => 'ein interner Schritt ist wiederholt fehlgeschlagen und konnte nicht abgeschlossen werden',
  abortNoSubscription: () => 'ich kann diese Unterhaltung nicht mehr mitlesen',
  resumed: () =>
    'Ich konnte diese Unterhaltung eine Zeit lang nicht mitlesen. Die Moderation läuft weiter. Wenn ihr in der Zwischenzeit etwas geschrieben habt, das zählen soll, postet es bitte noch einmal.',

  // ── Prozess ──────────────────────────────────────────────────────────────
  stepKinds: {
    open: 'Eröffnung',
    collect: 'Sammeln',
    discuss: 'Diskutieren',
    cluster: 'Clustern',
    prioritise: 'Priorisieren',
    decide: 'Entscheiden',
    assign: 'Zuweisen',
    close: 'Abschluss',
  },
  stepInstruction: {
    open: '',
    collect: 'Schreibt, was ihr einbringen wollt, ein Punkt pro Nachricht.',
    discuss: 'Sagt, was dafür und dagegen spricht und was euch daran wichtig ist.',
    cluster: 'Ich schlage Gruppen für das Gesammelte vor; ihr bestätigt oder korrigiert sie.',
    prioritise: '',
    decide: '',
    assign: '',
    close: '',
  },
  moveOnHint: { collect: 'Schreibt "weiter", wenn alles gesammelt ist.', discuss: 'Schreibt "weiter", wenn alles gesagt ist.' },
  afterInviteHint: () => 'Schreibt danach "weiter", um diesen Schritt abzuschließen.',
  agendaLine: (position, title, timebox) => `${String(position)}. ${title}${timebox ? ` (${String(timebox)} Min.)` : ''}`,
  stepOpened: (position, total, title, instruction, until) =>
    [`Schritt ${String(position)} von ${String(total)}: ${title}.`, instruction, until ? `Timebox bis ${until}.` : ''].filter((l) => l !== '').join(' '),
  stepClosed: (title) => `"${title}" ist abgeschlossen.`,
  stepExtended: (title, minutes, until) => `"${title}" wird um ${String(minutes)} Minuten verlängert, bis ${until}.`,
  timeboxOver: (title, contributions, people, of) =>
    `Die Timebox für "${title}" ist abgelaufen. Bisher: ${String(contributions)} ${contributions === 1 ? 'Beitrag' : 'Beiträge'} von ${String(people)} von ${String(of)} Personen.`,
  timeboxOverVote: (title, open) =>
    `Die Timebox für "${title}" ist abgelaufen; ${open === 1 ? 'ein Beitrag ist' : `${String(open)} Beiträge sind`} noch offen. Der Schritt bleibt offen, bis entschieden ist.`,
  needOptions: (title) => `"${title}" braucht noch seine Optionen, bevor ihr abstimmen könnt. Ich lege sie euch gleich vor.`,
  decisionSet: (title) => `Jetzt wird entschieden: ${title}.`,

  proposalKinds: {
    step_close: (title) => `"${title}" abschließen und weitergehen`,
    vote_close: (title, cast, of) => `die Abstimmung zu "${title}" jetzt schließen und die ${String(cast)} von ${String(of)} abgegebenen Stimmen auszählen`,
    clusters: (lines) => `das Gesammelte so gruppieren:\n${lines.map((l) => `- ${l}`).join('\n')}`,
    summary: (text) => `diese Zusammenfassung ins Protokoll nehmen:\n${text}`,
    decision: (statement) => `diese Entscheidung festhalten: ${statement}`,
    close: (summary) => `die Moderation mit dieser Zusammenfassung abschließen:\n${summary}`,
    media_consent: (what) => what,
  },
  proposalAnnounce: (what, until, extendable, mustReply) =>
    `Vorschlag: ${what}\nEr gilt, wenn bis ${until} niemand widerspricht, oder sofort, wenn alle zugestimmt haben. ${mustReply ? 'Antwortet auf diese Nachricht mit' : 'Schreibt'} "einverstanden" oder "Einwand: <euer Grund>"${extendable ? ' oder "verlängern 10" für zehn weitere Minuten' : ''}.${mustReply ? ' Nur eine Antwort auf diese Nachricht (oder ein 👍 darauf) zählt dafür.' : ''}`,
  proposalAccepted: (what) => `Angenommen, niemand hat widersprochen: ${what}`,
  proposalRejected: (what, objections) =>
    `Nicht angenommen: ${what}\n${objections.length === 1 ? 'Stehender Einwand' : 'Stehende Einwände'}:\n${objections.map((o) => `- ${o}`).join('\n')}`,
  proposalObjection: (name, reason) =>
    `${name} hat einen Einwand: ${reason}. Solange er steht, gilt der Vorschlag nicht. ${name}, schreib "einverstanden", wenn er für dich ausgeräumt ist.`,
  proposalBusy: () => 'Ein Vorschlag nach dem anderen: Zuerst wird der offene entschieden.',
  voteCloses: (rule, when) =>
    rule === 'at_deadline'
      ? `Diese Abstimmung schließt zur Deadline${when ? ` (${when})` : ''}.`
      : `Diese Abstimmung schließt, sobald alle abgestimmt haben${when ? `, spätestens zur Deadline (${when})` : ''}.`,
  voteCloseHow: () => 'Wenn ihr früher schließen wollt, schreibt "weiter": Dann frage ich die Runde, und sie schließt, wenn niemand widerspricht.',
  voteCloseNeedsVotes: () => 'Bisher hat niemand abgestimmt, es gibt also nichts auszuzählen. Sobald Stimmen da sind, könnt ihr mit "weiter" früher schließen; dann frage ich die Runde.',

  silentInviteDirect: (name, title) =>
    `Hallo ${name}, wir schließen gleich "${title}" ab. Wenn du noch etwas ergänzen möchtest, würde die Gruppe das gern hören. Schreib es bitte in die Gruppe; hier kann ich keine Beiträge annehmen.`,
  silentInviteGroup: (title) => `Bevor wir "${title}" abschließen: Wer bisher noch nicht dazu gekommen ist, kann jetzt gern etwas ergänzen.`,
  parked: (topic) => `Für später geparkt, damit wir beim aktuellen Schritt bleiben: ${topic}`,

  actionPrompt: (owner, number, description, due) =>
    `${owner}, Aufgabe #${String(number)} ist für dich vorgeschlagen: ${description}, fällig ${due}. Antworte hier in der Gruppe mit "ja", um sie zu übernehmen, oder mit "nein", um abzulehnen.`,
  actionConfirmed: (owner, number, description, due) => `Aufgabe #${String(number)}: ${description}. Verantwortlich: ${owner}, fällig ${due}.`,
  actionDeclined: (owner, number, description) => `${owner} hat Aufgabe #${String(number)} (${description}) abgelehnt. Sie hat noch keine verantwortliche Person.`,
  actionReminder: (owner, number, description, due) =>
    `Hallo ${owner}, Aufgabe #${String(number)} ist fällig ${due}: ${description}. Wenn sie erledigt ist, antworte mir hier mit "erledigt ${String(number)}", oder schreib es in die Gruppe und erwähne mich.`,
  actionReminderGroup: (owner, number, description, due) =>
    `${owner}, Aufgabe #${String(number)} ist fällig ${due}: ${description}. Antworte auf diese Nachricht mit "erledigt ${String(number)}", wenn sie erledigt ist.`,
  actionDone: (owner, number, description) => `Erledigt, danke ${owner}: #${String(number)} ${description}`,
  actionDoneWhich: (name, numbers) => `${name}, welche ist erledigt? Antworte mit ${numbers.map((n) => `"erledigt ${String(n)}"`).join(' oder ')}.`,
  actionNotYours: (name, number) => `${name}, Aufgabe #${String(number)} kannst nicht du abschließen.`,
  statusAfterClose: (s) =>
    [
      `Status: ${s.phase}${s.reason ? ` (${s.reason})` : ''}. Ziel: ${s.goal}`,
      ...(s.decisions.length > 0 ? ['Entscheidungen:', ...s.decisions.map((d) => `- ${d}`)] : []),
      `Beigetragen: ${s.contributed.length > 0 ? s.contributed.join(', ') : 'niemand'}`,
      ...(s.actions.length > 0 ? [`Aufgaben (${String(s.open)} offen):`, ...s.actions.map((a) => `- ${a}`)] : ['Aufgaben: keine']),
      ...(s.until ? [`Nachverfolgung bis: ${s.until}`] : []),
    ].join('\n'),
  actionStatus: (lines) => `Stand der Aufgaben:\n${lines.map((l) => `- ${l}`).join('\n')}`,
  actionLine: (number, description, owner, due, status) => `#${String(number)} ${description} (${owner}, fällig ${due}): ${status}`,
  actionStatusWords: { proposed: 'wartet auf die verantwortliche Person', confirmed: 'offen', done: 'erledigt', declined: 'abgelehnt' },
  followupEnded: () => 'Die Nachverfolgung der Aufgaben ist beendet. Ich lese diese Unterhaltung nicht mehr mit.',

  closeSummary: (s) =>
    [
      'Entscheidungen:',
      ...(s.decisions.length > 0 ? s.decisions.map((d) => `- ${d}`) : ['- keine']),
      'Nächste Schritte:',
      ...(s.actions.length > 0 ? s.actions.map((a) => `- ${a}`) : ['- keine']),
      'Offene Punkte:',
      ...(s.open.length > 0 ? s.open.map((o) => `- ${o}`) : ['- keine']),
    ].join('\n'),

  protocol: {
    title: (goal) => `Protokoll: ${goal}`,
    facilitator: 'Facilitator',
    initiator: 'Gestartet von',
    participants: 'Teilnehmende',
    left: 'ausgetreten',
    definitionOfDone: 'Definition of Done',
    version: 'Version',
    agenda: 'Agenda',
    decisions: 'Entscheidungen',
    rationale: 'Begründung',
    clusters: 'Von der Gruppe bestätigte Cluster',
    summaries: 'Von der Gruppe bestätigte Zusammenfassungen',
    contributions: 'Beiträge',
    actions: 'Aufgaben',
    parked: 'Offene Punkte (Themenspeicher)',
    changes: 'Regeländerungen',
    changeKinds: { proposal_accepted: 'Vorschlag angenommen', proposal_rejected: 'Vorschlag abgelehnt', proposal_amended: 'Vorschlag geändert' },
    runoff: (between) => `Stichwahl zwischen ${between}`,
    capabilities: 'Nutzung der zweckgebundenen Fähigkeiten',
    outcome: 'Ergebnis',
    none: 'keine',
  },

  // ── Ergebnis-Status und Zustellstatus (Spec 5.11) ─────────────────────────
  resultStatus: {
    label: 'Ergebnis-Status',
    published: 'veröffentlicht',
    confirmed: 'bestätigt',
    not_confirmed: 'nicht bestätigt',
    aborted: 'abgebrochen',
    reasons: {
      objection: 'Einwand',
      electorate_unverified: 'Teilnehmende konnten nicht geprüft werden',
      not_delivered: 'nicht zugestellt',
      stopped: 'Facilitation gestoppt',
    } as Record<string, string>,
    delivery: 'Zustellung',
    deliveryStatus: { pending: 'ausstehend', delivered: 'zugestellt', not_delivered: 'nicht zugestellt' } as Record<string, string>,
  },

  // ── Transparenz ──────────────────────────────────────────────────────────
  formats: {
    decision: 'Entscheidung',
    prioritisation: 'Priorisierung',
    assignment: 'Rollen- oder Aufgabenverteilung',
    ideas: 'Ideensammlung',
    retrospective: 'Retrospektive',
    alignment: 'Abstimmung',
    custom: 'Mit euch vereinbart',
  },
  handshakeFull: (h) =>
    [
      `Hallo, ich bin ${h.facilitator} und moderiere diese Unterhaltung ab jetzt. Ich bin neutral: Ich strukturiere den Weg, ihr entscheidet. Ich stimme nie mit ab und behandle jeden Beitrag gleich.`,
      `Gestartet von: ${h.initiator ?? 'der Person, die mich gerade darum gebeten hat'}`,
      `Ziel: ${h.goal}`,
      `Fertig, wenn (Version 1): ${h.definitionOfDone}`,
      `Format: ${h.format}`,
      ...(h.agenda.length > 0 ? ['Agenda:', ...h.agenda] : []),
      ...h.rules,
      h.participants.length === 0
        ? 'Teilnehmende: Die Mitgliederliste dieser Unterhaltung konnte ich nicht abrufen. Wer hier schreibt, nimmt teil.'
        : `Teilnehmende: ${h.participants.join(', ')}${h.rosterOpen ? ' (die Mitgliederliste konnte ich nicht vollständig abrufen; wer hier schreibt, nimmt teil)' : ''}`,
      ...(h.unmatched.length > 0 ? [`Ich weiß noch nicht, wer von euch ${h.unmatched.join(', ')} ${h.unmatched.length === 1 ? 'ist' : 'sind'}: Schreibt bitte einmal kurz hier.`] : []),
      ...(h.atDeadlineOnly ? ['Ich sehe nicht, wer alles zu dieser Unterhaltung gehört, und kann deshalb nicht erkennen, wann alle abgestimmt haben. Ich werte zur Deadline aus.'] : []),
      h.deadline ? `Deadline: ${h.deadline}` : 'Deadline: keine vereinbart',
      ...(h.reminders ? [`Erinnerungen: ${h.reminders} vor der Deadline, nur solange Beiträge offen sind; in der Gruppe ohne Namen und privat an die Betroffenen, wo ich sie erreiche.`] : []),
      ...(h.noReminders !== undefined ? [h.noReminders === null ? 'Erinnerungen: keine.' : `Erinnerungen: keine, die Deadline ist in ${String(h.noReminders)} ${h.noReminders === 1 ? 'Minute' : 'Minuten'}.`] : []),
      h.followUp
        ? 'Aufgaben: Ich erinnere die Verantwortlichen vor der Fälligkeit und höre auf, wenn alles erledigt oder überfällig ist.'
        : 'Aufgaben: keine Nachverfolgung nach dem Abschluss, außer ihr wünscht sie.',
      ...(h.protocolMail ? ['Protokoll: Nach dem Abschluss geht es zusätzlich per E-Mail an die Teilnehmenden, deren Adresse der Kanal kennt.'] : []),
      `Änderungen: Jede:r kann vorschlagen, die Definition of Done, die Methode oder die Deadline zu ändern. Eine Änderung gilt, wenn innerhalb von ${String(h.changeWindowHours)} Stunden niemand widerspricht (nie über die Deadline hinaus), und ich kündige sie mit neuer Version an.`,
      ...(h.perception ? [h.perception] : []),
      ...h.notes,
      h.initiator
        ? `Bericht: Das Ergebnis geht zuerst an diese Gruppe, danach mit dem Protokoll an ${h.initiator}. ${h.initiator} erhält nichts, was ihr nicht erfahren habt. Kann ich privat nicht schreiben, steht das Protokoll stattdessen hier.`
        : 'Bericht: Das Ergebnis geht zuerst an diese Gruppe, danach mit dem Protokoll an die Person, die diese Moderation gestartet hat. Sie erhält nichts, was ihr nicht erfahren habt. Kann ich privat nicht schreiben, steht das Protokoll stattdessen hier.',
      'Fragt jederzeit nach dem "Status". "Stopp" beendet die Moderation.',
    ].join('\n'),
  reminderTimes: (hours) =>
    // Whole hours in hours, everything else in minutes.
    hours.map((h) => (Number.isInteger(h) ? `${String(h)} Std.` : `${String(Math.max(1, Math.round(h * 60)))} Min.`)).join(', '),

  status: (s) =>
    [
      `Status: ${s.phase}. Ziel: ${s.goal}`,
      ...(s.step ? [`Aktueller Schritt: ${s.step}`] : []),
      `Definition of Done (Version ${String(s.dodVersion)}): ${s.definitionOfDone}`,
      `Beigetragen: ${s.contributed.length > 0 ? s.contributed.join(', ') : 'noch niemand'}`,
      `Noch offen: ${s.missing.length > 0 ? s.missing.join(', ') : 'niemand'}`,
      ...(s.options ? [`Optionen: ${s.options}`] : []),
      ...(s.tally ? [`${s.provisional ? 'Vorläufiger Stand' : 'Stand'}: ${s.tally}`] : []),
      ...(s.proposal ? [`Offener Vorschlag: ${s.proposal}`] : []),
      s.deadline ? `Deadline: ${s.deadline}` : 'Deadline: keine',
    ].join('\n'),

  initiatorReport: (name, outcome, protocol) =>
    `Hallo ${name}, du hast diese Moderation gestartet, deshalb hier der Bericht. Er enthält nichts, was die Gruppe nicht erfahren hat.\n\n${outcome}\n\n${protocol}`,
  protocolInGroup: (protocol) => `Den Bericht mit dem Protokoll konnte ich nicht allen privat senden, deshalb steht er hier:\n\n${protocol}`,

  change: {
    definition_of_done: (text, version) => `die Definition of Done ändern in (Version ${String(version)}): ${text}`,
    deadline: (when) => `die Deadline auf ${when} verlegen`,
    close_rule: (rule) =>
      rule === 'at_deadline' ? 'zur Deadline auswerten statt sobald alle beigetragen haben' : 'auswerten, sobald alle beigetragen haben, statt zur Deadline',
    method: (title, rules) => `ändern, wie "${title}" entschieden wird. ${rules}`,
    reminders: (times) => (times === '' ? 'vor der Deadline nicht mehr erinnern' : `${times} vor der Deadline erinnern`),
    dod_met: (summary) => `die Definition of Done ist erfüllt, und wir schließen damit ab:\n${summary}`,
  },
  changed: {
    definition_of_done: (version, text) => `Die Definition of Done gilt jetzt in Version ${String(version)}: ${text}`,
    deadline: (when) => `Die Deadline ist jetzt ${when}. Die Erinnerungen verschieben sich mit.`,
    close_rule: (rule) =>
      rule === 'at_deadline' ? 'Ab jetzt wird das Ergebnis zur Deadline ausgewertet.' : 'Ab jetzt wird ausgewertet, sobald alle beigetragen haben.',
    method: (title, rules) => `"${title}" wird jetzt so entschieden. ${rules}`,
    reminders: (times) => (times === '' ? 'Vor der Deadline wird nicht mehr erinnert.' : `Erinnert wird jetzt ${times} vor der Deadline.`),
  },
  actAgain: (names) => `Beiträge nach den alten Regeln passen nicht mehr. Bitte tragt noch einmal bei: ${names}.`,

  // ── Operator, Kontingente, Aufbewahrung ──────────────────────────────────
  system: {
    messageQuota: (max) =>
      `Systemhinweis: Diese Moderation hat ihr Limit von ${String(max)} Nachrichten des Facilitators erreicht. Ab jetzt wird nur noch das Ergebnis oder ein Abbruchbericht gepostet. Ein Operator kann das Limit anheben.`,
    activeQuota: (max) =>
      `Systemhinweis: Dieser Facilitator führt bereits ${String(max)} Moderationen, das ist sein Limit. Er kann erst eine weitere starten, wenn eine davon beendet ist. Ein Operator kann das Limit anheben.`,
    instanceQuota: (max) =>
      `Systemhinweis: Diese Instanz führt bereits ${String(max)} Moderationen, das ist ihr Limit. Im Moment kann keine weitere gestartet werden.`,
    startQuota: (max) =>
      `Systemhinweis: Dieser Facilitator hat in der letzten Stunde ${String(max)} Moderationen gestartet, das ist sein Limit. Bitte versucht es später noch einmal.`,
  },
  abortResultUndelivered: (error) => `das Ergebnis konnte nicht in die Gruppe gepostet werden (${error})`,
  resultUndeliveredReport: (result) => `Ich konnte das Ergebnis nicht in die Gruppe posten. Das wurde erreicht:\n\n${result}`,
  messageUnprocessed: () => 'Eine Nachricht hier konnte wegen eines technischen Problems nicht verarbeitet werden. Falls du darauf wartest, dass ich etwas erfasse, schick es bitte noch einmal.',
  defaultDod: (goal, decision) => (decision ? `Es ist entschieden: ${goal}` : `Die Gruppe hat erreicht: ${goal}`),
  notEverybodyYet: () => 'Es haben noch nicht alle beigetragen. Ich nenne hier niemanden; Erinnerungen gehen an die Betroffenen.',
  stillOpen: (title, deadline) => `"${title}" ist noch offen${deadline ? ` bis ${deadline}` : ''}. Fragt nach dem "Status", um zu sehen, wo wir stehen.`,
  refusals: {
    generic: 'Das konnte ich gerade nicht ausführen. Fragt nach dem "Status", um zu sehen, wo wir stehen.',
    deciding_step: 'Dieser Schritt wird durch seine Abstimmung entschieden. Er schließt, wenn das Ergebnis feststeht: sobald alle beigetragen haben, oder zur Deadline, wenn das so vereinbart ist.',
    closing_step: 'Der Abschlussschritt endet, wenn ihr die Zusammenfassung bestätigt habt.',
    proposal_open: 'Ein Vorschlag nach dem anderen: Der offene wird zuerst entschieden.',
    no_open_step: 'Gerade ist kein Schritt offen.',
    not_a_deciding_step: 'Dieser Schritt wird nicht durch eine Abstimmung entschieden, es gibt also keine Methode zu ändern. Schreibt "weiter", um weiterzugehen.',
    foreign_options: 'Ich kann nur die Optionen dieses Schritts zur Abstimmung stellen. Wenn ihr andere Optionen wollt, schlagt sie ausdrücklich vor.',
    ballots_exist: 'In diesem Schritt wurde schon abgestimmt. Eine Änderung braucht jetzt einen Vorschlag, dem ihr alle zustimmt.',
  },
  guardFallback: () => 'Ich konnte meine Antwort gerade nicht in Worte fassen. Fragt nach dem "Status", um zu sehen, wo wir stehen.',
  abortConfiguringExpired: () => 'sie wurde nicht innerhalb der Zeit eröffnet, die das Einrichten einer Moderation dauern darf',
  abortLifetime: (days) => `die maximale Dauer von ${String(days)} Tagen ist erreicht`,
  abortOperator: (reason) => `ein Operator hat sie beendet (${reason})`,
  abortAgentDisabled: () => 'dieser Facilitator wurde von einem Operator deaktiviert und kann nicht mehr moderieren',
  abortAgentDeleted: () => 'dieser Facilitator wird von einem Operator gelöscht',
  abortArchetypeRemoved: () => 'der Archetyp Facilitator wird von dieser Instanz entfernt, deshalb kann hier kein Facilitator mehr moderieren',
  notVisible: () => 'Du nimmst an dieser Moderation nicht teil, deshalb steht dir ihr Protokoll nicht zur Verfügung.',

  // ── Sessions und Medien ──────────────────────────────────────────────────
  perceive: {
    intro: 'Was ich hier wahrnehme:',
    text: 'Ich lese den Chat',
    message_edits: 'bearbeitete Nachrichten',
    reactions: 'Reaktionen auf meine eigenen Beiträge',
    card_answers: 'die Umfragen',
    presence: 'wer dazukommt und geht',
    hand_raise: 'gehobene Hände',
    transcribed_speech: 'das im Call Gesagte als Transkript mit Sprecher:in',
    shared_documents: 'geteilte Dokumente',
    not: {
      transcribed_speech: 'Ich höre den Call nicht',
      hand_raise: 'Gehobene Hände sehe ich nicht',
      presence: 'Ich sehe nicht, wer anwesend ist',
      card_answers: 'Umfragen kann ich hier nicht stellen, abgestimmt wird also im Chat',
      private_messages: 'Privat kann ich hier niemandem schreiben, Erinnerungen bleiben also in der Gruppe',
    },
    sentence: (can, cannot) => `Was ich hier wahrnehme: ${can.join(', ')}.${cannot.length > 0 ? ` ${cannot.join('. ')}.` : ''} Niemand sollte von mehr ausgehen.`,
  },
  pollHint: (ballotExample) => `Antwortet in der Umfrage oder schreibt eure Wahl in den Chat (z. B. "${ballotExample}").`,
  pollUnverified: (name, summary) =>
    `${name}, unter deinem Namen kam eine Umfrage-Antwort, die die Plattform nicht bestätigen konnte: ${summary}. Antworte in der Gruppe mit "ja", damit sie zählt.`,
  sessionAgenda: (title, when, agenda) =>
    [`Agenda für "${title}" am ${when}:`, ...agenda, 'Themen und Unterlagen, die ihr einbringen wollt: schreibt sie vorab hier hinein, ein Punkt pro Nachricht.'].join('\n'),
  sessionStarted: (title, until, perception) => [`"${title}" beginnt jetzt.${until ? ` Wir haben Zeit bis ${until}.` : ''}`, perception].join('\n'),
  meetingDiffers: (gained, lost) =>
    ['In dieser Unterhaltung läuft ein Meeting.', ...(gained.length > 0 ? [`Darin nehme ich zusätzlich wahr: ${gained.join(', ')}.`] : []), ...(lost.length > 0 ? [`Nicht mehr wahr nehme ich: ${lost.join(', ')}.`] : [])].join(' '),
  sessionEnded: (title) => `"${title}" ist beendet. Was noch offen ist, geht hier im Chat weiter.`,
  timeNotice: (title, minutes) => `Zeit-Check: noch ${String(minutes)} Minuten für "${title}".`,
  speakingOrder: (names, remoteFirst) =>
    `Reihenfolge für diese Runde${remoteFirst ? ' (Remote zuerst)' : ''}: ${names.join(', ')}. Sagt "passe", wenn ihr nichts ergänzen möchtet.`,
  capabilityGained: (what) => `In dieser Session hat sich etwas geändert. Ich nehme jetzt zusätzlich wahr: ${what.join(', ')}.`,
  capabilityLost: (what) => `In dieser Session hat sich etwas geändert. Ich nehme nicht mehr wahr: ${what.join(', ')}. Ich mache mit dem weiter, was bleibt.`,
  mediaConsent: () =>
    'das transkribierte Gesprochene dieses Calls verarbeiten, damit ich festhalten kann, was gesagt wird. Roh-Audio und -Video werden nicht gespeichert, nur das Protokoll. Jede:r kann es jederzeit mit "nicht mithören" stoppen',
  mediaConsentGranted: () => 'Ich folge jetzt dem Transkript des Calls. Was ich aus Gesprochenem festhalte, bleibt unbestätigt, bis die Person es im Chat bestätigt. "Nicht mithören" beendet es sofort.',
  mediaConsentRefused: () => 'Verstanden. Ich verarbeite das Gesprochene dieses Calls nicht und arbeite nur mit Chat und Umfragen weiter.',
  mediaStopped: (name) => `${name} hat mich gebeten aufzuhören. Ich verarbeite das Gesprochene dieses Calls nicht mehr.`,
  spokenEcho: (name, summary) =>
    `${name}, ich habe dich so gehört: ${summary}. Antworte im Chat mit "ja", um zu bestätigen, oder korrigiere mich. Es zählt, sobald du bestätigt hast.`,

  // ── zweckgebundene Fähigkeiten ───────────────────────────────────────────
  stakeholderRoles: { receives_protocol: 'das Protokoll erhält', invited_to_followups: 'zu Folgeterminen eingeladen wird' },
  proposeStakeholder: (name, role) => `${name} als Stakeholder aufnehmen, der bzw. die ${role}`,
  proposeFollowupMeeting: (subject, minutes, from, to) =>
    `nach dem Abschluss suche ich eine gemeinsame freie Zeit und verschicke die Einladung für "${subject}" (${String(minutes)} Minuten, zwischen ${from} und ${to}). Dafür lese ich nur, wann jemand belegt ist, nie, was die Termine sind`,
  capabilityLog: {
    names: { 'free/busy': 'Verfügbarkeiten', invitation: 'Einladung', 'protocol mail': 'Protokoll per Mail' },
    refused: (capability, reason) => `${capability}: abgelehnt (${reason})`,
    refusedByIntegration: (capability, reason) => `${capability}: von der Integration abgelehnt (${reason})`,
    outcomeUnknown: (capability, detail) => `${capability}: Ausgang unbekannt (${detail})`,
    freeBusy: (people, from, to) => `Verfügbarkeiten von ${String(people)} Personen gelesen, ${from} bis ${to}`,
    invitation: (subject, start, people) => `Einladung "${subject}" für ${start} an ${String(people)} Personen gesendet`,
    mailed: (addresses) => `Protokoll per Mail an ${String(addresses)} ${addresses === 1 ? 'Adresse' : 'Adressen'} gesendet`,
    grantIssued: (addresses) => `Freigabe für ${String(addresses)} ${addresses === 1 ? 'Adresse' : 'Adressen'} erteilt (Teilnehmende und bestätigte Stakeholder)`,
    grantRevoked: (reason) => `Freigabe beendet: ${reason === 'followup_ended' ? 'Die Nachverfolgung ist abgeschlossen' : 'Die Zeit für die Nachverfolgung ist abgelaufen'}`,
    protocolSent: (participants) => `Protokoll privat an ${String(participants)} ${participants === 1 ? 'Teilnehmer:in' : 'Teilnehmende'} gesendet`,
  },
  protocolDirect: (name, protocol) => `Hallo ${name}, hier ist das Protokoll der Moderation, an der du teilgenommen hast.\n\n${protocol}`,
  protocolMailSubject: (goal) => `Protokoll: ${goal}`,
  protocolSent: (channel, mail) =>
    `Das Protokoll ist verschickt: privat an ${String(channel)} Teilnehmende${mail > 0 ? ` und per Mail an ${String(mail)} ${mail === 1 ? 'Adresse' : 'Adressen'}` : ''}.`,
  protocolMailNoAddresses: (protocol) =>
    `Ich kann das Protokoll nicht mailen: Dieser Kanal liefert mir keine Mail-Adressen der Teilnehmenden, und im Chat sammle ich keine Adressen ein. ${protocol === undefined ? 'Das Protokoll steht in dieser Gruppe.' : `Hier ist es stattdessen:\n\n${protocol}`}`,
  protocolMailUnavailable: (reason) => `Das Protokoll konnte nicht gemailt werden (${reason}). Es steht in dieser Gruppe, und die Teilnehmenden haben es privat erhalten, wo ich sie erreiche.`,
  followupCreated: (subject, when, link, unknown) =>
    `Der Folgetermin "${subject}" steht für ${when} in den Kalendern.${link ? '' : ' Die Einladung ging ohne Meeting-Link raus.'}${unknown > 0 ? ` Für ${String(unknown)} ${unknown === 1 ? 'Person' : 'Personen'} konnte ich keine Verfügbarkeit sehen, prüft die Zeit bitte.` : ''}`,
  protocolMailUnknown: () => 'Ich weiß nicht, ob die Protokoll-Mail rausgegangen ist: Der Maildienst hat nicht geantwortet. Ich sende sie nicht noch einmal, damit niemand sie doppelt bekommt. Bitte prüft das oder teilt das Protokoll aus dieser Gruppe.',
  followupUnknown: (subject) => `Ich weiß nicht, ob die Einladung für "${subject}" rausgegangen ist: Der Kalenderdienst hat nicht geantwortet. Ich sende sie nicht noch einmal. Bitte prüft eure Kalender und verschickt sie selbst, falls sie fehlt.`,
  followupNoSlot: (subject) => `Ich habe zwischen den vereinbarten Daten keine Zeit gefunden, zu der alle für "${subject}" frei sind. Bitte wählt selbst eine Zeit.`,
  followupUnavailable: (subject, reason) => `Ich konnte "${subject}" nicht terminieren (${reason}). Bitte verschickt die Einladung selbst.`,
  followupReasons: {
    not_configured: 'für diese Instanz ist keine Kalender-Integration eingerichtet',
    no_service: 'es ist keine Kalender-Integration installiert',
    recipient_not_allowed: 'jemand auf der Liste wurde von der Gruppe nicht bestätigt',
    provider_error: 'der Kalenderdienst hat einen Fehler gemeldet',
    grant_revoked: 'die Nachverfolgung dieser Moderation ist beendet',
    grant_refused: 'die Instanz hat das nicht freigegeben (die Moderation wurde gestoppt, oder die Zeit dafür ist abgelaufen)',
    no_grant_service: 'diese Instanz kann einer Moderation keinen Zugriff auf Mail oder Kalender freigeben',
    unknown_outcome: 'der Dienst hat nicht geantwortet',
    no_addresses: 'dieser Kanal liefert mir keine Mail-Adressen der Teilnehmenden, und im Chat sammle ich keine Adressen ein',
  },
  invitationBody: (goal, summary) => `Folgetermin zu "${goal}".\n\n${summary}`,

  phase: {
    configuring: 'wird eingerichtet',
    active: 'läuft',
    concluding: 'wird abgeschlossen',
    closed: 'abgeschlossen',
    aborted: 'ohne Ergebnis beendet',
    following_up: 'abgeschlossen, die Aufgaben werden nachverfolgt',
    ended: 'beendet',
  },
  execution: {
    turnLimit: () => 'Ich konnte auf die letzte Nachricht nicht antworten: Die Grenze für eine einzelne Antwort von mir wurde erreicht. Abstimmungen, "Status" und "Stopp" funktionieren wie bisher.',
    turnBudget: () => 'Das Budget für eigene Antworten von mir ist für diesen Teil der Moderation aufgebraucht. Abstimmungen, "Status" und "Stopp" funktionieren wie bisher, und das Ergebnis wird weiterhin ausgewertet.',
  },
  privateStatus: {
    which: (goals) => `Du nimmst an mehreren meiner Moderationen teil. Welche meinst du? Antworte mit "Status" und der Nummer:\n${goals.map((goal, i) => `${String(i + 1)}. ${goal}`).join('\n')}`,
    doneWhich: (items) => `Welche deiner Aufgaben ist erledigt? Antworte mit "erledigt" und der Nummer:\n${items.join('\n')}`,
    done: (number, description) => `Notiert: Aufgabe ${String(number)} ("${description}") ist erledigt. Ich sage es der Gruppe.`,
    nothingOpen: () => 'Du hast in keiner meiner Moderationen eine offene Aufgabe.',
  },
};
