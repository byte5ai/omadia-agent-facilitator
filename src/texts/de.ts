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

  phase: {
    configuring: 'wird eingerichtet',
    active: 'läuft',
    concluding: 'wird abgeschlossen',
    closed: 'abgeschlossen',
    aborted: 'ohne Ergebnis beendet',
  },
};
