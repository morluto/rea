import { fail } from './store.mjs';
const string = { type: 'string' },
  identifier = { type: 'string', minLength: 1, maxLength: 2000 };
const object = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const mail = object(
  {
    to: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 320 },
      minItems: 1,
      maxItems: 100,
    },
    subject: { type: 'string', maxLength: 998 },
    body: { type: 'string', maxLength: 200000 },
  },
  ['to', 'subject', 'body'],
);
const event = object(
  {
    calendarId: identifier,
    summary: { type: 'string', maxLength: 1000 },
    description: { type: 'string', maxLength: 20000 },
    start: { type: 'string' },
    end: { type: 'string' },
    timezone: { type: 'string', maxLength: 100 },
  },
  ['summary', 'start', 'end', 'timezone'],
);
const operation = (name, description, method, path, inputSchema, adapter) => ({
  name,
  description,
  method,
  path,
  inputSchema,
  policy: 'ask',
  ...(adapter ? { adapter } : {}),
});
const exactId = object({ id: identifier }, ['id']);
const labelIds = { type: 'array', items: identifier, maxItems: 100 };
const page = { maxResults: { type: 'integer', minimum: 1, maximum: 100 }, pageToken: string };
const label = {
  name: { type: 'string', minLength: 1, maxLength: 225 },
  labelListVisibility: { type: 'string', enum: ['labelShow', 'labelShowIfUnread', 'labelHide'] },
  messageListVisibility: { type: 'string', enum: ['show', 'hide'] },
};
const googleMailTools = () => [
  operation(
    'mail.list_drafts',
    'List Gmail drafts with continuation tokens.',
    'GET',
    '/gmail/v1/users/me/drafts',
    object({ ...page, q: string }),
  ),
  operation(
    'mail.read_draft',
    'Read one exact Gmail draft.',
    'GET',
    '/gmail/v1/users/me/drafts/{id}',
    exactId,
  ),
  operation(
    'mail.update_draft',
    'Replace one selected draft with explicit recipients, subject and text.',
    'PUT',
    '/gmail/v1/users/me/drafts/{id}',
    object({ ...mail.properties, id: identifier }, ['id', ...mail.required]),
    'gmail-draft',
  ),
  operation(
    'mail.send_draft',
    'Send a selected existing draft. Provider acceptance is not delivery.',
    'POST',
    '/gmail/v1/users/me/drafts/send',
    exactId,
  ),
  operation(
    'mail.list_threads',
    'Search Gmail threads, retaining the next page token.',
    'GET',
    '/gmail/v1/users/me/threads',
    object({ ...page, q: string, labelIds }),
    'google-query',
  ),
  operation(
    'mail.read_thread',
    'Read messages in an exact Gmail thread.',
    'GET',
    '/gmail/v1/users/me/threads/{id}',
    exactId,
  ),
  operation(
    'mail.modify_labels',
    'Add or remove labels on one selected message.',
    'POST',
    '/gmail/v1/users/me/messages/{id}/modify',
    object({ id: identifier, addLabelIds: labelIds, removeLabelIds: labelIds }, ['id']),
  ),
  operation(
    'mail.modify_thread_labels',
    'Add or remove labels on a selected thread.',
    'POST',
    '/gmail/v1/users/me/threads/{id}/modify',
    object({ id: identifier, addLabelIds: labelIds, removeLabelIds: labelIds }, ['id']),
  ),
  operation(
    'mail.mark_read',
    'Remove the UNREAD label from a message.',
    'POST',
    '/gmail/v1/users/me/messages/{id}/modify',
    exactId,
    'gmail-mark-read',
  ),
  operation(
    'mail.mark_unread',
    'Add the UNREAD label to a message.',
    'POST',
    '/gmail/v1/users/me/messages/{id}/modify',
    exactId,
    'gmail-mark-unread',
  ),
  operation(
    'mail.archive',
    'Remove the INBOX label; do not delete the message.',
    'POST',
    '/gmail/v1/users/me/messages/{id}/modify',
    exactId,
    'gmail-archive',
  ),
  operation(
    'mail.move_to_inbox',
    'Add the INBOX label to a message.',
    'POST',
    '/gmail/v1/users/me/messages/{id}/modify',
    exactId,
    'gmail-inbox',
  ),
  operation(
    'mail.trash',
    'Move one selected message to Trash, not permanent deletion.',
    'POST',
    '/gmail/v1/users/me/messages/{id}/trash',
    exactId,
  ),
  operation(
    'mail.untrash',
    'Remove one selected message from Trash.',
    'POST',
    '/gmail/v1/users/me/messages/{id}/untrash',
    exactId,
  ),
  operation(
    'mail.trash_thread',
    'Move one selected thread to Trash.',
    'POST',
    '/gmail/v1/users/me/threads/{id}/trash',
    exactId,
  ),
  operation(
    'mail.untrash_thread',
    'Remove one selected thread from Trash.',
    'POST',
    '/gmail/v1/users/me/threads/{id}/untrash',
    exactId,
  ),
  operation(
    'mail.list_labels',
    'List labels for the authenticated Gmail account.',
    'GET',
    '/gmail/v1/users/me/labels',
    object({}),
  ),
  operation(
    'mail.read_label',
    'Read one exact Gmail label.',
    'GET',
    '/gmail/v1/users/me/labels/{id}',
    exactId,
  ),
  operation(
    'mail.create_label',
    'Create a user label with explicit visibility.',
    'POST',
    '/gmail/v1/users/me/labels',
    object(label, ['name']),
  ),
  operation(
    'mail.update_label',
    'Patch a selected user label, not message contents.',
    'PATCH',
    '/gmail/v1/users/me/labels/{id}',
    object({ id: identifier, ...label }, ['id']),
  ),
  operation(
    'mail.delete_label',
    'Delete one selected user label. This does not delete messages.',
    'DELETE',
    '/gmail/v1/users/me/labels/{id}',
    exactId,
  ),
  operation(
    'mail.read_attachment',
    'Read Gmail attachment bytes as provider base64url data; bounded by connector response limits.',
    'GET',
    '/gmail/v1/users/me/messages/{messageId}/attachments/{id}',
    object({ messageId: identifier, id: identifier }, ['messageId', 'id']),
  ),
];
export function providerPreset(provider, service) {
  if (provider === 'google' && service === 'mail')
    return {
      endpoint: 'https://gmail.googleapis.com',
      scope: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'],
      tools: [
        operation(
          'mail.search',
          'Search the selected Gmail account. Results are provider records, not proof of full mailbox coverage.',
          'GET',
          '/gmail/v1/users/me/messages',
          object({
            q: string,
            labelIds,
            includeSpamTrash: { type: 'boolean' },
            maxResults: { type: 'integer', minimum: 1, maximum: 100 },
            pageToken: string,
          }),
          'google-query',
        ),
        operation(
          'mail.read',
          'Read one message by exact Gmail ID.',
          'GET',
          '/gmail/v1/users/me/messages/{id}',
          object(
            {
              id: identifier,
              format: { type: 'string', enum: ['full', 'metadata', 'raw', 'minimal'] },
            },
            ['id'],
          ),
        ),
        operation(
          'mail.draft',
          'Create a Gmail draft from explicit recipients, subject and text body.',
          'POST',
          '/gmail/v1/users/me/drafts',
          mail,
          'gmail-draft',
        ),
        operation(
          'mail.send',
          'Send now from the selected Gmail account. Requires concrete action approval. A provider response does not prove delivery.',
          'POST',
          '/gmail/v1/users/me/messages/send',
          mail,
          'gmail-send',
        ),
        operation(
          'mail.delete_draft',
          'Delete an exact selected Gmail draft ID.',
          'DELETE',
          '/gmail/v1/users/me/drafts/{id}',
          object({ id: identifier }, ['id']),
        ),
        ...googleMailTools(),
      ],
    };
  if (provider === 'google' && service === 'calendar')
    return {
      endpoint: 'https://www.googleapis.com',
      scope: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
      tools: [
        operation(
          'calendar.list',
          'List events from a selected Google calendar (default primary).',
          'GET',
          '/calendar/v3/calendars/{calendarId}/events',
          object({
            calendarId: identifier,
            timeMin: string,
            timeMax: string,
            maxResults: { type: 'integer', minimum: 1, maximum: 250 },
            pageToken: string,
            q: string,
          }),
          'google-calendar-list',
        ),
        operation(
          'calendar.create',
          'Create an event with explicit RFC3339 start/end and IANA timezone.',
          'POST',
          '/calendar/v3/calendars/{calendarId}/events',
          event,
          'google-calendar-event',
        ),
        operation(
          'calendar.delete',
          'Delete one selected calendar event; does not cancel unrelated work.',
          'DELETE',
          '/calendar/v3/calendars/{calendarId}/events/{eventId}',
          object({ calendarId: identifier, eventId: identifier }, ['eventId']),
          'google-calendar-list',
        ),
        operation(
          'calendar.read',
          'Read one exact Google Calendar event.',
          'GET',
          '/calendar/v3/calendars/{calendarId}/events/{eventId}',
          object({ calendarId: identifier, eventId: identifier }, ['eventId']),
          'google-calendar-list',
        ),
        operation(
          'calendar.update',
          'Update the title, description and times of an exact event.',
          'PATCH',
          '/calendar/v3/calendars/{calendarId}/events/{eventId}',
          object({ ...event.properties, eventId: identifier }, [...event.required, 'eventId']),
          'google-calendar-event',
        ),
        operation(
          'calendar.instances',
          'List occurrences of one recurring event with paging.',
          'GET',
          '/calendar/v3/calendars/{calendarId}/events/{eventId}/instances',
          object(
            {
              calendarId: identifier,
              eventId: identifier,
              ...page,
              timeMin: string,
              timeMax: string,
            },
            ['eventId'],
          ),
          'google-calendar-list',
        ),
      ],
    };
  if (provider === 'microsoft' && service === 'mail')
    return {
      endpoint: 'https://graph.microsoft.com',
      scope: ['openid', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'],
      tools: [
        operation(
          'mail.search',
          'List messages in the selected Microsoft account.',
          'GET',
          '/v1.0/me/messages',
          object({
            $filter: string,
            $search: string,
            $top: { type: 'integer', minimum: 1, maximum: 100 },
            $skiptoken: string,
          }),
        ),
        operation(
          'mail.read',
          'Read one Microsoft Graph message ID.',
          'GET',
          '/v1.0/me/messages/{id}',
          object({ id: identifier }, ['id']),
        ),
        operation(
          'mail.draft',
          'Create a draft in the selected Microsoft mailbox.',
          'POST',
          '/v1.0/me/messages',
          mail,
          'graph-draft',
        ),
        operation(
          'mail.send',
          'Send now through Microsoft Graph. HTTP 202 means accepted for processing, not delivered.',
          'POST',
          '/v1.0/me/sendMail',
          mail,
          'graph-send',
        ),
        operation(
          'mail.delete_draft',
          'Delete an exact mailbox message/draft ID.',
          'DELETE',
          '/v1.0/me/messages/{id}',
          object({ id: identifier }, ['id']),
        ),
        operation(
          'mail.list_drafts',
          'List drafts from the selected Microsoft mailbox.',
          'GET',
          '/v1.0/me/mailFolders/drafts/messages',
          object({
            $top: { type: 'integer', minimum: 1, maximum: 100 },
            $skip: { type: 'integer', minimum: 0 },
          }),
        ),
        operation(
          'mail.send_draft',
          'Send an existing message draft. Acceptance does not prove delivery.',
          'POST',
          '/v1.0/me/messages/{id}/send',
          exactId,
        ),
        operation(
          'mail.move',
          'Move a selected message to an exact destination folder.',
          'POST',
          '/v1.0/me/messages/{id}/move',
          object({ id: identifier, destinationId: identifier }, ['id', 'destinationId']),
        ),
        operation(
          'mail.update',
          'Update read state, importance or categories on a selected message.',
          'PATCH',
          '/v1.0/me/messages/{id}',
          object(
            {
              id: identifier,
              isRead: { type: 'boolean' },
              importance: { type: 'string', enum: ['low', 'normal', 'high'] },
              categories: { type: 'array', items: string, maxItems: 100 },
            },
            ['id'],
          ),
        ),
        operation(
          'mail.reply',
          'Reply to one message with an explicit text comment.',
          'POST',
          '/v1.0/me/messages/{id}/reply',
          object({ id: identifier, comment: { type: 'string', maxLength: 200000 } }, [
            'id',
            'comment',
          ]),
        ),
        operation(
          'mail.reply_all',
          'Reply to all original recipients. Requires explicit review.',
          'POST',
          '/v1.0/me/messages/{id}/replyAll',
          object({ id: identifier, comment: { type: 'string', maxLength: 200000 } }, [
            'id',
            'comment',
          ]),
        ),
        operation(
          'mail.list_folders',
          'List Microsoft mailbox folders.',
          'GET',
          '/v1.0/me/mailFolders',
          object({ $top: { type: 'integer', minimum: 1, maximum: 100 } }),
        ),
        operation(
          'mail.folder_messages',
          'List messages from an exact mailbox folder.',
          'GET',
          '/v1.0/me/mailFolders/{folderId}/messages',
          object(
            {
              folderId: identifier,
              $top: { type: 'integer', minimum: 1, maximum: 100 },
              $skip: { type: 'integer', minimum: 0 },
              $filter: string,
            },
            ['folderId'],
          ),
        ),
        operation(
          'mail.list_attachments',
          'List attachment metadata for a selected Microsoft message.',
          'GET',
          '/v1.0/me/messages/{id}/attachments',
          exactId,
        ),
      ],
    };
  if (provider === 'microsoft' && service === 'calendar')
    return {
      endpoint: 'https://graph.microsoft.com',
      scope: ['openid', 'offline_access', 'User.Read', 'Calendars.ReadWrite'],
      tools: [
        operation(
          'calendar.list',
          'List events from the selected Microsoft account.',
          'GET',
          '/v1.0/me/events',
          object({ $filter: string, $top: { type: 'integer', minimum: 1, maximum: 100 } }),
        ),
        operation(
          'calendar.create',
          'Create a Microsoft event with explicit start/end and provider-supported timezone.',
          'POST',
          '/v1.0/me/events',
          event,
          'graph-event',
        ),
        operation(
          'calendar.delete',
          'Delete one exact Microsoft calendar event ID.',
          'DELETE',
          '/v1.0/me/events/{eventId}',
          object({ eventId: identifier }, ['eventId']),
        ),
        operation(
          'calendar.read',
          'Read one exact Microsoft event.',
          'GET',
          '/v1.0/me/events/{eventId}',
          object({ eventId: identifier }, ['eventId']),
        ),
        operation(
          'calendar.update',
          'Update a selected event title, description and times.',
          'PATCH',
          '/v1.0/me/events/{eventId}',
          object({ ...event.properties, eventId: identifier }, [...event.required, 'eventId']),
          'graph-event',
        ),
        operation(
          'calendar.accept',
          'Accept one selected meeting invitation.',
          'POST',
          '/v1.0/me/events/{eventId}/accept',
          object({ eventId: identifier, comment: string, sendResponse: { type: 'boolean' } }, [
            'eventId',
          ]),
        ),
        operation(
          'calendar.decline',
          'Decline one selected meeting invitation.',
          'POST',
          '/v1.0/me/events/{eventId}/decline',
          object({ eventId: identifier, comment: string, sendResponse: { type: 'boolean' } }, [
            'eventId',
          ]),
        ),
      ],
    };
  fail('unsupported_provider', 'Choose Google or Microsoft mail/calendar');
}
export function adaptOperation(op, args) {
  const values = { ...args };
  let body = { ...args };
  const labels = {
    'gmail-mark-read': { removeLabelIds: ['UNREAD'] },
    'gmail-mark-unread': { addLabelIds: ['UNREAD'] },
    'gmail-archive': { removeLabelIds: ['INBOX'] },
    'gmail-inbox': { addLabelIds: ['INBOX'] },
  };
  if (labels[op.adapter]) body = labels[op.adapter];
  if (op.adapter?.startsWith('google-calendar')) values.calendarId ??= 'primary';
  if (op.adapter === 'gmail-send' || op.adapter === 'gmail-draft') {
    if (args.to.some((v) => /[\r\n]/.test(v)) || /[\r\n]/.test(args.subject))
      fail('invalid_input', 'Mail headers must be single-line values');
    const subject = /[^\x20-\x7e]/.test(args.subject)
      ? `=?UTF-8?B?${Buffer.from(args.subject).toString('base64')}?=`
      : args.subject;
    const raw = Buffer.from(
      `To: ${args.to.join(', ')}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${
        Buffer.from(args.body)
          .toString('base64')
          .match(/.{1,76}/g)
          ?.join('\r\n') ?? ''
      }`,
    ).toString('base64url');
    body = op.adapter === 'gmail-draft' ? { message: { raw } } : { raw };
  }
  if (op.adapter === 'graph-draft' || op.adapter === 'graph-send') {
    body = {
      subject: args.subject,
      body: { contentType: 'Text', content: args.body },
      toRecipients: args.to.map((address) => ({ emailAddress: { address } })),
    };
    if (op.adapter === 'graph-send') body = { message: body, saveToSentItems: true };
  }
  if (op.adapter === 'google-calendar-event' || op.adapter === 'graph-event') {
    const start = Date.parse(args.start),
      end = Date.parse(args.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      fail('invalid_input', 'Provide valid start/end dates with end after start');
    body =
      op.adapter === 'google-calendar-event'
        ? {
            summary: args.summary,
            description: args.description ?? '',
            start: { dateTime: args.start, timeZone: args.timezone },
            end: { dateTime: args.end, timeZone: args.timezone },
          }
        : {
            subject: args.summary,
            body: { contentType: 'Text', content: args.description ?? '' },
            start: { dateTime: args.start, timeZone: args.timezone },
            end: { dateTime: args.end, timeZone: args.timezone },
          };
  }
  const used = new Set();
  const path = op.path.replace(/\{([a-zA-Z][\w]*)\}/g, (_, key) => {
    if (values[key] === undefined) fail('invalid_input', `Missing path identity: ${key}`);
    used.add(key);
    return encodeURIComponent(String(values[key]));
  });
  const query = Object.fromEntries(Object.entries(values).filter(([key]) => !used.has(key)));
  if (!op.adapter) body = query;
  const queryEntries = Object.entries(query).flatMap(([key, value]) =>
    op.adapter === 'google-query' && Array.isArray(value)
      ? value.map((item) => [key, String(item)])
      : [[key, typeof value === 'string' ? value : JSON.stringify(value)]],
  );
  return { path, query, queryEntries, body };
}
