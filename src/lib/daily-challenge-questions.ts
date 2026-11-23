// Versioned content: keep v1 stable because a day's completion voucher uses its version.
// These are educational prompts, not investment or personalised financial advice.
const sets = [
  {
    title: 'Spot the scam',
    questions: [
      [
        'Someone asks for your wallet recovery phrase to send a prize. What should you do?',
        ['Keep it private and stop the conversation', 'Share only half', 'Send it if their logo looks official'],
        0,
        'A recovery phrase gives control of your wallet. Receiving a prize never requires sharing it.',
      ],
      [
        'A message says you must pay immediately to unlock a free prize. Your first step?',
        [
          'Pay before time runs out',
          'Verify the offer through the service’s official channel',
          'Forward it to friends',
        ],
        1,
        'Urgency can discourage checking. Independently verify unexpected payment requests.',
      ],
      [
        'Which is the safest way to visit a service you already use?',
        ['An unsolicited shortened link', 'The first reply under a social post', 'Your saved, verified bookmark'],
        2,
        'A verified bookmark reduces the chance of landing on an impersonation site.',
      ],
    ],
  },
  {
    title: 'Know your wallet',
    questions: [
      [
        'What can you share to receive tokens?',
        ['Your private key', 'Your public wallet address', 'Your recovery phrase'],
        1,
        'Your public address receives tokens. Private keys and recovery phrases must stay secret.',
      ],
      [
        'Before confirming a transaction, what should you check?',
        ['Only the app logo', 'The recipient, action and amount', 'How many likes the app has'],
        1,
        'Check what you are authorising, the destination and any cost in your wallet.',
      ],
      [
        'What is a network fee?',
        ['A guaranteed prize', 'Your password reset cost', 'A cost for processing a transaction on the network'],
        2,
        'A network fee pays for transaction processing. It is separate from the value transferred.',
      ],
    ],
  },
  {
    title: 'A little budgeting',
    questions: [
      [
        'You have ₦2,000 and set aside ₦600 for data. How much remains?',
        ['₦1,400', '₦2,600', '₦600'],
        0,
        '₦2,000 minus ₦600 leaves ₦1,400 for other needs.',
      ],
      [
        'What is a helpful first step when planning a weekly budget?',
        [
          'Count a possible prize as guaranteed income',
          'List money available and essential costs',
          'Ignore small purchases',
        ],
        1,
        'Start with money you actually have and the costs you need to cover.',
      ],
      [
        'What does moving money between budgets do?',
        ['Creates extra money', 'Doubles the balance', 'Changes its intended use'],
        2,
        'Budget allocations describe how existing money will be used; they do not create money.',
      ],
    ],
  },
  {
    title: 'Find better opportunities',
    questions: [
      [
        'Before applying for a scholarship, where should you verify its deadline?',
        ['The organiser’s official website', 'An undated screenshot', 'An unrelated comment'],
        0,
        'The official listing is the best starting point for current requirements and deadlines.',
      ],
      [
        'What makes an application easier to review?',
        ['Unrelated copied text', 'Clear examples matching the requirements', 'A blank work history'],
        1,
        'Relevant examples help a reviewer understand how you meet the stated requirements.',
      ],
      [
        'An opportunity promises a guaranteed job for an upfront payment. What should you do?',
        ['Pay without checking', 'Share your banking password', 'Investigate the organisation and terms first'],
        2,
        'Treat a guaranteed-job claim cautiously and check it independently before committing.',
      ],
    ],
  },
  {
    title: 'Learn a little better',
    questions: [
      [
        'After a practice question, which action helps you learn from an error?',
        ['Review the explanation', 'Hide the result', 'Memorise only the option letter'],
        0,
        'Understanding the explanation helps you apply the idea to a different question.',
      ],
      [
        'Which study plan is easier to maintain?',
        ['Only studying the night before', 'Short sessions with regular review', 'Never testing yourself'],
        1,
        'A repeatable schedule gives you more opportunities to practise and identify gaps.',
      ],
      [
        'How can an AI explanation be used responsibly?',
        ['Assume it is always right', 'Submit it without reading', 'Check it against reliable course material'],
        2,
        'AI can make mistakes. Compare explanations with your course material and work through them yourself.',
      ],
    ],
  },
  {
    title: 'Everyday airtime maths',
    questions: [
      [
        'Five people each receive ₦1,000 airtime. What is the total?',
        ['₦500', '₦5,000', '₦50,000'],
        1,
        'Five multiplied by ₦1,000 is ₦5,000.',
      ],
      [
        'Before topping up a phone, what should you double-check?',
        ['The phone number and network', 'Your wallpaper', 'Your follower count'],
        0,
        'Checking the destination and network helps prevent sending a top-up to the wrong place.',
      ],
      [
        'A payment is pending. What should you do first?',
        ['Immediately pay again', 'Delete the receipt', 'Check the existing transaction status'],
        2,
        'A pending payment may still complete. Check its status before starting another payment.',
      ],
    ],
  },
  {
    title: 'Your weekly reset',
    questions: [
      [
        'What helps you understand where money went this week?',
        ['Reviewing your transaction history', 'Guessing from memory alone', 'Ignoring small transactions'],
        0,
        'Transaction history gives you a record to compare against your plans.',
      ],
      [
        'Which is a clear goal for next week?',
        ['Do everything', 'Complete three short practice sessions', 'Never make a mistake'],
        1,
        'A specific, achievable action makes progress easier to recognise.',
      ],
      [
        'Missing one day of practice means…',
        ['All previous learning disappears', 'You must give up', 'You can resume with the next session'],
        2,
        'Your earlier learning still matters. Returning to the habit is the next useful step.',
      ],
    ],
  },
] as const

export function dailyQuestions(day: number) {
  const set = sets[((day % sets.length) + sets.length) % sets.length]
  return {
    title: set.title,
    questions: set.questions.map(([prompt, options, correctOption, explanation]) => ({
      prompt,
      options: [...options],
      correctOption,
      explanation,
    })),
  }
}
