// German mirror of en.ts.

import type { Texts } from './en.js';

export const de: Texts = {
  list: (items) => {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1] ?? ''}`;
  },

  handshake: (h) =>
    [
      `Hallo, ich bin ${h.facilitator} und moderiere diese Unterhaltung ab jetzt. Ich bin neutral: Ich strukturiere den Weg, ihr entscheidet.`,
      `Gestartet von: ${h.initiator}`,
      `Ziel: ${h.goal}`,
      `Fertig, wenn: ${h.definitionOfDone}`,
      `Teilnehmende: ${h.participants.join(', ')}`,
      ...(h.deadline ? [`Deadline: ${h.deadline}`] : []),
      ...(h.rules ?? []),
      `Das Ergebnis geht zuerst an diese Gruppe, danach mit dem Protokoll an ${h.initiator}. ${h.initiator} erhält nichts, was ihr nicht erfahren habt.`,
      'Fragt jederzeit nach dem "Status". "Stopp" beendet die Moderation.',
    ].join('\n'),

  echoRecorded: (name, summary) => `Für dich erfasst, ${name}: ${summary}`,
  echoInterpreted: (name, summary) =>
    `${name}, ich habe deine Nachricht so verstanden: ${summary}. Antworte mit "ja" (oder reagiere mit 👍), um zu bestätigen, oder korrigiere mich. Es zählt, sobald du bestätigt hast.`,
  echoChanged: (name, summary) => `Für dich geändert, ${name}: ${summary}`,
  echoConfirmed: (name, summary) => `Bestätigt, ${name}: ${summary}`,
  echoDeclined: (name) => `Verstanden, ${name}: Ich habe das nicht erfasst.`,
  echoWithdrawn: (name) => `${name}, du hast deine Nachricht gelöscht, deshalb habe ich den Beitrag daraus zurückgezogen.`,
  whichConfirmation: (name, open) =>
    `${name}, mehrere Dinge warten auf deine Bestätigung. Antworte bitte direkt auf das, was du meinst:\n${open.map((o) => `- ${o}`).join('\n')}`,

  stopped: (name) => `${name} hat um Stopp gebeten. Die Moderation endet hier ohne Ergebnis. Es wird nichts weiter gesendet.`,
  aborted: (reason) => `Diese Moderation endet ohne Ergebnis. Grund: ${reason}`,

  joined: (name, goal) =>
    `Willkommen, ${name}. Diese Unterhaltung wird moderiert. Ziel: ${goal}. Du zählst ab jetzt als Teilnehmende:r; frag nach dem "Status", um zu sehen, wo wir stehen.`,
  left: (name) => `${name} hat die Unterhaltung verlassen. Die bisherigen Beiträge bleiben gezählt.`,
  initiatorLeft: (name) =>
    `${name} hat diese Moderation gestartet und die Unterhaltung verlassen. Ab jetzt erhält ${name} weder weitere Beiträge noch den Bericht.`,

  statusBasics: (s) =>
    [
      `Status: ${s.phase}. Ziel: ${s.goal}`,
      `Definition of Done: Version ${String(s.dodVersion)}`,
      `Beigetragen: ${s.contributed.length > 0 ? s.contributed.join(', ') : 'noch niemand'}`,
      `Noch offen: ${s.missing.length > 0 ? s.missing.join(', ') : 'niemand'}`,
      ...(s.deadline ? [`Deadline: ${s.deadline}`] : []),
    ].join('\n'),

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
      ...(r.atDeadline ? [`Die Deadline ist erreicht; ${String(r.atDeadline.contributed)} von ${String(r.atDeadline.of)} haben beigetragen, und dies ist das Ergebnis der abgegebenen Beiträge.`] : []),
      'Diese Moderation ist abgeschlossen. Danke euch.',
    ].join('\n'),
  abortTie: (tied) => `die Deadline ist erreicht und die Abstimmung steht gleichauf zwischen ${tied}`,
  abortObjection: (objections) => `die Deadline ist erreicht und es steht ein Einwand (${objections})`,
  abortOpenItems: (items) => `die Deadline ist erreicht und Folgendes ist noch offen: ${items}`,
  abortNothing: () => 'die Deadline ist erreicht und die Definition of Done ist nicht erfüllt',

  reminderGroup: (open, deadline) =>
    `Erinnerung: ${open === 1 ? 'Ein Beitrag ist' : `${String(open)} Beiträge sind`} noch offen.${deadline ? ` Deadline: ${deadline}.` : ''} Fragt nach dem "Status" für die Details.`,
  reminderDirect: (name, goal, deadline) =>
    `Hallo ${name}, dein Beitrag zu "${goal}" ist noch offen.${deadline ? ` Deadline: ${deadline}.` : ''} Bitte antworte in der Gruppe; hier kann ich keine Beiträge annehmen.`,
  directUnreachable: () =>
    'Ich kann hier nicht alle privat erreichen (meine App ist nicht bei allen installiert). Erinnerungen bleiben deshalb in dieser Gruppe, ohne Namen.',
  abortJobFailed: () => 'ein interner Schritt ist wiederholt fehlgeschlagen und konnte nicht abgeschlossen werden',

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
    clusters: (lines) => `das Gesammelte so gruppieren:\n${lines.map((l) => `- ${l}`).join('\n')}`,
    summary: (text) => `diese Zusammenfassung ins Protokoll nehmen:\n${text}`,
    decision: (statement) => `diese Entscheidung festhalten: ${statement}`,
    close: (summary) => `die Moderation mit dieser Zusammenfassung abschließen:\n${summary}`,
  },
  proposalAnnounce: (what, until, extendable) =>
    `Vorschlag: ${what}\nEr gilt, wenn bis ${until} niemand widerspricht, oder sofort, wenn alle zugestimmt haben. Schreibt "einverstanden" oder "Einwand: <euer Grund>"${extendable ? ' oder "verlängern 10" für zehn weitere Minuten' : ''}.`,
  proposalAccepted: (what) => `Angenommen, niemand hat widersprochen: ${what}`,
  proposalRejected: (what, objections) =>
    `Nicht angenommen: ${what}\n${objections.length === 1 ? 'Stehender Einwand' : 'Stehende Einwände'}:\n${objections.map((o) => `- ${o}`).join('\n')}`,
  proposalObjection: (name, reason) =>
    `${name} hat einen Einwand: ${reason}. Solange er steht, gilt der Vorschlag nicht. ${name}, schreib "einverstanden", wenn er für dich ausgeräumt ist.`,
  proposalBusy: () => 'Ein Vorschlag nach dem anderen: Zuerst wird der offene entschieden.',

  silentInviteDirect: (name, title) =>
    `Hallo ${name}, wir schließen gleich "${title}" ab. Wenn du noch etwas ergänzen möchtest, würde die Gruppe das gern hören. Schreib es bitte in die Gruppe; hier kann ich keine Beiträge annehmen.`,
  silentInviteGroup: (title) => `Bevor wir "${title}" abschließen: Wer bisher noch nicht dazu gekommen ist, kann jetzt gern etwas ergänzen.`,
  parked: (topic) => `Für später geparkt, damit wir beim aktuellen Schritt bleiben: ${topic}`,

  actionPrompt: (owner, number, description, due) =>
    `${owner}, Aufgabe #${String(number)} ist für dich vorgeschlagen: ${description}, fällig ${due}. Antworte hier in der Gruppe mit "ja", um sie zu übernehmen, oder mit "nein", um abzulehnen.`,
  actionConfirmed: (owner, number, description, due) => `Aufgabe #${String(number)}: ${description}. Verantwortlich: ${owner}, fällig ${due}.`,
  actionDeclined: (owner, number, description) => `${owner} hat Aufgabe #${String(number)} (${description}) abgelehnt. Sie hat noch keine verantwortliche Person.`,
  actionReminder: (owner, number, description, due) =>
    `Hallo ${owner}, Aufgabe #${String(number)} ist fällig ${due}: ${description}. Wenn sie erledigt ist, schreib "erledigt ${String(number)}" in die Gruppe.`,
  actionReminderGroup: (owner, number, description, due) =>
    `${owner}, Aufgabe #${String(number)} ist fällig ${due}: ${description}. Schreib "erledigt ${String(number)}", wenn sie erledigt ist.`,
  actionDone: (owner, number, description) => `Erledigt, danke ${owner}: #${String(number)} ${description}`,
  actionNotYours: (name, number) => `${name}, Aufgabe #${String(number)} kannst nicht du abschließen.`,
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
    capabilities: 'Nutzung der zweckgebundenen Fähigkeiten',
    outcome: 'Ergebnis',
    none: 'keine',
  },

  phase: {
    configuring: 'wird eingerichtet',
    active: 'läuft',
    concluding: 'wird abgeschlossen',
    closed: 'abgeschlossen',
    aborted: 'ohne Ergebnis beendet',
  },
};
