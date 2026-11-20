// Texts of linked session conversations, session closings and spoken
// contributions (spec 5.3, 6.3; #2076, #2077). Kept apart from en.ts/de.ts:
// several streams change those in parallel.

const enTexts = {
  linkKeyword: /\b(link|connect|session chat|meeting chat)\b/i,
  linkConfirmedHere: (goal: string, session: string): string =>
    `This chat is now linked to "${goal}" as the conversation of the session "${session}". Until the session starts I only read what is addressed to me here. When it starts I moderate here; I never bring the history of the main conversation into this chat.`,
  linkConfirmedHome: (who: string, session: string): string => `${who} linked the meeting chat for the session "${session}". The session itself runs there.`,
  linkNotParticipant: (): string => 'Only a participant of that facilitation can link this chat, from inside it.',
  linkWhich: (goals: readonly string[]): string => `Which facilitation do you mean? Name it in your message:\n${goals.map((goal) => `- ${goal}`).join('\n')}`,
  linkFromHome: (): string => 'A meeting chat is linked from inside it: mention me there and name this facilitation. From here I cannot take it.',
  linkBusy: (session: string, holder: 'discussion' | 'process'): string =>
    `I could not link the meeting chat for "${session}": ${holder === 'discussion' ? 'an agent discussion runs there' : 'another facilitation runs there'}. Nothing changed here.`,
  linkFailed: (session: string, reason: string): string => `I could not link the meeting chat for "${session}" (${reason}). Nothing changed here.`,
  notReadyHome: (session: string, missing: string): string =>
    `The session "${session}" cannot start in its meeting chat yet: ${missing}. Nothing changes here; I try again shortly.`,
  readyAgainHome: (session: string): string => `The meeting chat of "${session}" is ready now.`,
  sessionMissed: (session: string, missing: string | undefined): string =>
    `The session "${session}" did not take place in its meeting chat${missing ? `: ${missing}` : ''}. What it was for continues here.`,
  sessionCancelledThere: (session: string): string => `The session "${session}" does not take place: the facilitation has ended. Nothing more happens in this chat.`,
  defaultSessionTitle: (): string => 'Session in the meeting chat',
  guestStatus: (lines: readonly string[], sessions: number = lines.length): string => `Status of your session${sessions > 1 ? 's' : ''}:\n${lines.join('\n')}`,
  guestStatusLine: (title: string, state: string, when: string | undefined): string => `- ${title}: ${state}${when ? ` (${when})` : ''}`,
  openStepLine: (step: string): string => `- Now: ${step}`,
  sessionState: { scheduled: 'scheduled', live: 'running', confirming: 'summary awaiting confirmation', closed: 'closed', cancelled: 'cancelled' } as Record<string, string>,
  summaryTitle: (session: string): string => `Summary of the session "${session}"`,
  summaryDecisions: 'Decisions',
  summaryNextSteps: 'Next steps',
  summaryOpen: 'Open points',
  summaryNone: '(none)',
  summaryFooter: (eventId: string, version: number): string => `Closing ${eventId}, document version ${String(version)}.`,
  summaryConsent: (until: string): string =>
    `Please confirm this summary: reply "agreed", or "objection: <reason>" to this message. Without an objection it counts as confirmed on ${until}.`,
  summaryConfirmed: (session: string): string => `The summary of "${session}" is confirmed.`,
  summaryNotConfirmed: (session: string, status: string): string => `The summary of "${session}" stands as: ${status}.`,
  summaryObjection: (who: string, reason: string): string => `Objection from ${who}: ${reason}. The summary is not confirmed while it stands.`,
  summaryObjectionNeedsReason: (who: string): string => `${who}, please give a reason: "objection: <reason>".`,
  spokenParticipantEcho: (name: string, text: string): string =>
    `${name}, the transcript has you saying: "${text}". Reply "yes" to confirm it as your contribution. It counts once you confirmed exactly this.`,
  spokenShared: (text: string): string =>
    `From the room transcript: "${text}". Whoever said this can reply "mine" to this message to adopt it as their own contribution.`,
  adopted: (name: string): string => `${name} adopted this from the transcript.`,
  adoptOutdated: (name: string): string => `${name}, that transcript text was corrected since. Reply "mine" to the corrected version.`,
  adoptNoStep: (name: string): string => `${name}, no step is open, so there is nothing to adopt it for right now.`,
  adoptedMarker: 'adopted from the transcript',
  stepElectorateSession: (step: string, session: string): string => `"${step}" is decided by the participants of "${session}", here in this chat.`,
  notConfirmedAtDeadline: (session: string, status: string): string => `the summary of the session "${session}" is ${status}, so the definition of done is not met at the deadline`,
};

export type SessionTexts = typeof enTexts;

const deTexts: SessionTexts = {
  linkKeyword: /\b(link|verknüpf\w*|verbind\w*|meeting-?chat|sitzungs-?chat)\b/i,
  linkConfirmedHere: (goal, session) =>
    `Dieser Chat ist jetzt mit „${goal}“ verknüpft, als Konversation der Sitzung „${session}“. Bis die Sitzung beginnt, lese ich hier nur, was an mich gerichtet ist. Ab dem Start moderiere ich hier; den Verlauf der Hauptkonversation bringe ich nie in diesen Chat.`,
  linkConfirmedHome: (who, session) => `${who} hat den Meeting-Chat für die Sitzung „${session}“ verknüpft. Die Sitzung selbst läuft dort.`,
  linkNotParticipant: () => 'Nur wer an dieser Moderation teilnimmt, kann diesen Chat verknüpfen, und zwar von hier aus.',
  linkWhich: (goals) => `Welche Moderation meinst du? Nenne sie in deiner Nachricht:\n${goals.map((goal) => `- ${goal}`).join('\n')}`,
  linkFromHome: () => 'Ein Meeting-Chat wird von innen verknüpft: erwähne mich dort und nenne diese Moderation. Von hier aus kann ich ihn nicht übernehmen.',
  linkBusy: (session, holder) =>
    `Ich konnte den Meeting-Chat für „${session}“ nicht verknüpfen: ${holder === 'discussion' ? 'dort läuft eine Agenten-Diskussion' : 'dort läuft eine andere Moderation'}. Hier ändert sich nichts.`,
  linkFailed: (session, reason) => `Ich konnte den Meeting-Chat für „${session}“ nicht verknüpfen (${reason}). Hier ändert sich nichts.`,
  notReadyHome: (session, missing) =>
    `Die Sitzung „${session}“ kann in ihrem Meeting-Chat noch nicht beginnen: ${missing}. Hier ändert sich nichts; ich versuche es gleich noch einmal.`,
  readyAgainHome: (session) => `Der Meeting-Chat von „${session}“ ist jetzt bereit.`,
  sessionMissed: (session, missing) => `Die Sitzung „${session}“ hat in ihrem Meeting-Chat nicht stattgefunden${missing ? `: ${missing}` : ''}. Worum es ging, geht hier weiter.`,
  sessionCancelledThere: (session) => `Die Sitzung „${session}“ findet nicht statt: die Moderation ist beendet. In diesem Chat passiert nichts mehr.`,
  defaultSessionTitle: () => 'Sitzung im Meeting-Chat',
  guestStatus: (lines, sessions = lines.length) => `Stand deiner Sitzung${sessions > 1 ? 'en' : ''}:\n${lines.join('\n')}`,
  guestStatusLine: (title, state, when) => `- ${title}: ${state}${when ? ` (${when})` : ''}`,
  openStepLine: (step) => `- Jetzt: ${step}`,
  sessionState: { scheduled: 'geplant', live: 'läuft', confirming: 'Zusammenfassung wartet auf Bestätigung', closed: 'abgeschlossen', cancelled: 'abgesagt' },
  summaryTitle: (session) => `Zusammenfassung der Sitzung „${session}“`,
  summaryDecisions: 'Entscheidungen',
  summaryNextSteps: 'Nächste Schritte',
  summaryOpen: 'Offene Punkte',
  summaryNone: '(keine)',
  summaryFooter: (eventId, version) => `Abschluss ${eventId}, Dokumentversion ${String(version)}.`,
  summaryConsent: (until) =>
    `Bitte bestätigt diese Zusammenfassung: antwortet auf diese Nachricht mit „einverstanden“ oder „Einwand: <Grund>“. Ohne Einwand gilt sie am ${until} als bestätigt.`,
  summaryConfirmed: (session) => `Die Zusammenfassung von „${session}“ ist bestätigt.`,
  summaryNotConfirmed: (session, status) => `Die Zusammenfassung von „${session}“ gilt als: ${status}.`,
  summaryObjection: (who, reason) => `Einwand von ${who}: ${reason}. Solange er steht, ist die Zusammenfassung nicht bestätigt.`,
  summaryObjectionNeedsReason: (who) => `${who}, bitte nenne einen Grund: „Einwand: <Grund>“.`,
  spokenParticipantEcho: (name, text) =>
    `${name}, laut Transkript hast du gesagt: „${text}“. Antworte mit „ja“, um es als deinen Beitrag zu bestätigen. Es zählt, sobald du genau das bestätigt hast.`,
  spokenShared: (text) =>
    `Aus dem Raum-Transkript: „${text}“. Wer das gesagt hat, kann mit „meins“ auf diese Nachricht antworten und es als eigenen Beitrag übernehmen.`,
  adopted: (name) => `${name} hat das aus dem Transkript übernommen.`,
  adoptOutdated: (name) => `${name}, dieser Transkript-Text wurde inzwischen korrigiert. Antworte mit „meins“ auf die korrigierte Fassung.`,
  adoptNoStep: (name) => `${name}, gerade ist kein Schritt offen, für den du es übernehmen könntest.`,
  adoptedMarker: 'aus dem Transkript übernommen',
  stepElectorateSession: (step, session) => `Über „${step}“ entscheiden die Teilnehmenden von „${session}“, hier in diesem Chat.`,
  notConfirmedAtDeadline: (session, status) => `die Zusammenfassung der Sitzung „${session}“ ist ${status}, damit ist die Definition of Done zur Deadline nicht erfüllt`,
};

export const sessionTexts = (language: 'de' | 'en'): SessionTexts => (language === 'de' ? deTexts : enTexts);
