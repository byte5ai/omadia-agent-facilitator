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

  phase: {
    configuring: 'wird eingerichtet',
    active: 'läuft',
    concluding: 'wird abgeschlossen',
    closed: 'abgeschlossen',
    aborted: 'ohne Ergebnis beendet',
  },
};
