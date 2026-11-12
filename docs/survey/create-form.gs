/**
 * Builds the SafeBalance survey as a Google Form in YOUR Google account,
 * with a linked Google Sheet for the responses.
 *
 * How to use:
 *  1. Go to https://script.google.com and click "New project".
 *  2. Delete what's there, paste this whole file, and click Save.
 *  3. Choose the function "createSafeBalanceSurvey" and click Run.
 *  4. Google asks you to allow the script to manage your Forms and Sheets.
 *     Because it's your own script, Google may show "Google hasn't verified
 *     this app": click Advanced, then "Go to (your project name)".
 *  5. Open "Execution log": it shows the link to share and the link to edit.
 *
 * The questions match docs/survey/questionnaire.md. Each person answers
 * "About you", then the section for their role (A, B or C), then D to F.
 */
function createSafeBalanceSurvey() {
  var form = FormApp.create('SafeBalance survey: getting paid safely');
  form
    .setDescription(
      "We're building a service that makes sure workers get paid their balance and clients only pay for work that's done. " +
        'Your answers will shape what we build. It takes about 8 minutes.\n\n' +
        'Answers are anonymous unless you choose to leave your contact at the end. We use them only for research and, ' +
        'if you agree, to invite you to try the service early.'
    )
    .setProgressBar(true)
    .setCollectEmail(false)
    .setAllowResponseEdits(false)
    .setConfirmationMessage(
      'Thank you! Your answers help us build something that actually works for you. ' +
        "If you left your number, we'll be in touch on WhatsApp."
    );

  var JOB_SIZES = ['Under ₦20,000', '₦20,000–₦100,000', '₦100,000–₦500,000', '₦500,000–₦2 million', 'Over ₦2 million'];
  var LOSSES = ['Nothing', 'Under ₦50,000', '₦50,000–₦200,000', '₦200,000–₦1 million', 'Over ₦1 million'];

  // ---------- About you ----------
  var role = form
    .addMultipleChoiceItem()
    .setTitle('Which best describes you?')
    .setHelpText('Pick the one that fits you best.')
    .setRequired(true);
  short(form, 'What exactly do you do?', 'For example: electrician, tailor, graphic designer, building contractor, estate manager.', true);
  list(form, 'Where do you mostly work?', [
    'Lagos', 'Abuja (FCT)', 'Rivers', 'Oyo', 'Ogun', 'Kano', 'Kaduna', 'Enugu', 'Anambra', 'Delta', 'Edo',
    'Another state', 'Outside Nigeria',
  ]);
  mc(form, 'How long have you been doing this?', ['Less than 1 year', '1–3 years', '4–10 years', 'More than 10 years']);

  // ---------- A. Workers ----------
  var pageA = form.addPageBreakItem().setTitle('Getting paid for your work');
  mc(form, 'How many jobs or clients do you handle in a typical month?', ['1–2', '3–5', '6–10', '11–20', 'More than 20']);
  mc(form, 'What is the size of a typical job?', JOB_SIZES);
  cb(form, 'How do clients usually find you?', [
    'WhatsApp', 'Instagram', 'Facebook', 'TikTok', 'X (Twitter)', 'Referrals / word of mouth', 'Job sites or marketplaces',
    'Estate manager or association', 'My shop / walk-ins',
  ], { other: true });
  cb(form, 'How do you usually agree on a job?', ['Verbally', 'WhatsApp chat', 'Written quote or invoice', 'Signed contract']);
  mc(form, 'How do clients usually pay you?', [
    'Full payment upfront', 'Part upfront, balance after', 'Full payment after the job', 'In bits over time', 'It varies',
  ]);
  mc(form, 'If you take a deposit, how much is it usually?', ['No deposit', '10–30%', '40–60%', '70% or more']);
  mc(form, 'In the last 12 months, has a client delayed or refused to pay your balance?', ['Never', 'Once', '2–5 times', 'More than 5 times'], { required: true });
  mc(form, 'Roughly how much money have you lost, or waited months for, in the last 12 months?', LOSSES);
  cb(form, "The last time a client didn't pay, what did you do?", [
    'Kept calling or messaging', 'Went to their place', 'Involved friends, family or my association', 'Involved police or a lawyer',
    'Posted about it on social media', 'Gave up', "It hasn't happened to me",
  ]);
  mc(form, "Have you lost jobs because clients didn't trust you with a deposit?", ['Often', 'Sometimes', 'Never']);
  mc(form, "How often do clients complain your work isn't what was agreed?", ['Often', 'Sometimes', 'Rarely', 'Never']);
  para(form, 'What is your biggest headache about getting paid?');

  // ---------- B. Contractors and project professionals ----------
  var pageB = form.addPageBreakItem().setTitle('Projects, subcontractors and payments');
  mc(form, 'What is the size of a typical project?', ['Under ₦1 million', '₦1–10 million', '₦10–50 million', '₦50–200 million', 'Over ₦200 million']);
  cb(form, 'Who are your clients?', [
    'Individuals / homeowners', 'Nigerians abroad', 'Private companies or developers', 'Government', "Other contractors (I'm a subcontractor)",
  ]);
  mc(form, 'How many people or subcontractors do you pay on a typical project?', ['Just me', '2–5', '6–20', 'More than 20']);
  mc(form, 'How are you usually paid on a project?', [
    'Mobilisation, then milestones', 'Monthly valuations / certificates', 'Pay as we go', 'Full payment upfront', 'Full payment on completion',
  ]);
  mc(form, 'How often are client payments late?', ['Never', 'Sometimes', 'Often', 'Almost always'], { required: true });
  mc(form, 'When a payment is late, how long is the delay usually?', ['Under 2 weeks', '2–4 weeks', '1–3 months', 'More than 3 months']);
  mc(form, "Have you ever had to stop work because the client didn't pay?", ['Yes', 'No']);
  mc(form, 'Is retention held on your projects (e.g. 5–10% kept until the defects period ends)?', [
    "Yes, and it's paid on time", "Yes, but it's often paid late or never", 'No',
  ]);
  cb(form, 'What problems do you have with materials?', [
    'Less delivered than paid for', 'Price changed after payment', 'Theft or diversion on site', 'Late delivery', 'None',
  ]);
  mc(form, 'How do you track project money today?', ['Notebook', 'Excel / Google Sheets', 'Accounting software', 'WhatsApp messages', 'Nothing formal']);
  cb(form, 'Who has to approve payments on your projects?', [
    'The client only', 'QS or engineer certifies', 'Project manager', 'Company finance team', 'Me alone',
  ]);
  mc(form, "Do subcontractors or workers get paid late because you're waiting on the client?", ['Often', 'Sometimes', 'Never']);
  para(form, 'What is the biggest money problem on your projects?');

  // ---------- C. People who hire ----------
  var pageC = form.addPageBreakItem().setTitle('Hiring workers');
  mc(form, 'How often do you hire artisans, freelancers or contractors?', ['Every week', 'Every month', 'A few times a year', 'Rarely']);
  mc(form, 'How much do you usually pay for one job?', JOB_SIZES);
  cb(form, 'In the last 12 months, has a worker…', [
    'Taken a deposit and disappeared', 'Done poor work and refused to fix it', 'Used cheaper materials than agreed', 'Finished very late',
    'Asked for more money in the middle of the job', 'None of these',
  ], { required: true });
  mc(form, 'Roughly how much have you lost to bad workers in the last 12 months?', LOSSES);
  cb(form, 'How do you find workers you can trust?', [
    'Referrals', 'Estate or facility manager', 'Online / social media', 'Associations', 'I stick to the same people',
  ], { other: true });
  mc(form, 'Are you managing a job or building project from another city or abroad?', ['Yes, from abroad', 'Yes, from another city', 'No']);
  cb(form, 'What would make you trust a new worker? (pick up to 3)', [
    'Verified ID', 'Reviews from past clients', 'Photos of past work', 'My money held safely until the job is done',
    'Someone I know recommends them', 'A lower price',
  ], { max: 3 });
  para(form, 'What is your biggest headache about hiring workers?');

  // ---------- D. The idea (everyone) ----------
  var pageD = form
    .addPageBreakItem()
    .setTitle('Our idea')
    .setHelpText(
      'How SafeBalance would work: before work on each stage starts, the client pays into a locked account held by a licensed bank ' +
        'or payment company. The worker can see the money is there, does the work, and sends photos as proof. The client approves ' +
        "and the worker is paid straight away. If the client doesn't respond within 72 hours, the worker is paid automatically. " +
        "If there's a problem, the money stays locked until a neutral mediator settles it. It works on WhatsApp, so no app is needed."
    );
  form
    .addScaleItem()
    .setTitle('Would you use a service like this?')
    .setBounds(1, 5)
    .setLabels('Definitely not', 'Definitely yes')
    .setRequired(true);
  mc(form, 'If you are paid for work: would most of your clients agree to lock the money before you start?', [
    'Most would', 'About half', 'Few would', "I don't know", "I don't get paid for work",
  ]);
  mc(form, "If you hire: would you lock the money before work starts, knowing you get it back if the job isn't done?", [
    'Yes, always', 'Only for new workers', 'Only for big jobs', 'No', "I don't hire people",
  ]);
  cb(form, 'What would make clients more willing to lock their money?', [
    "Full refund if the job isn't done", 'A short warranty after the job', "Seeing the worker's ID and reviews",
    'Paying in parts before work starts', 'A small fee', 'Knowing which bank holds the money',
  ]);
  mc(form, 'For a ₦100,000 job, what fee would feel fair to the person paying it?', [
    '₦1,000 (1%)', '₦2,000 (2%)', '₦3,000 (3%)', '₦5,000 (5%)', 'More than ₦5,000', 'No fee would feel fair',
  ], { required: true });
  mc(form, 'Who should pay the fee?', ['The client', 'The worker', 'Split 50/50', 'It depends on the job']);
  mc(form, 'After a stage is approved, how fast should the worker get the money?', ['Instantly', 'Same day', 'Within 2 days', "It doesn't matter much"]);
  mc(form, 'Would you verify your identity with BVN or NIN to receive money?', ['Yes, either', 'Only NIN', 'Only BVN', 'No']);
  cb(form, 'How would you prefer to use it?', ['WhatsApp', 'Mobile app', 'Website', 'USSD code (*xxx#)', 'Through a POS agent']);
  mc(form, 'If there is a dispute, an AI could suggest a fair split based on the evidence. Nothing is paid unless both sides accept; otherwise a human decides. How do you feel about this?', [
    'Comfortable', 'Comfortable, as long as a human can always review', "I'd prefer only humans", 'Not sure',
  ]);
  mc(form, '"Pay small small": the client pays a stage in parts, and work starts once it\'s fully paid. How useful is this?', [
    'Very useful', 'Somewhat useful', 'Not useful',
  ]);
  cb(form, 'What worries you most about a service like this?', [
    'Money getting stuck', 'Fake copies / scams', 'The fee', 'Unfair dispute decisions', 'Hard to use', "Clients won't agree",
    'Privacy of my data',
  ], { other: true });

  // ---------- E. Features (everyone) ----------
  form.addPageBreakItem().setTitle('What should we build next?');
  cb(form, 'Pick up to 3 features that would matter most to you', [
    'Pay subcontractors automatically from each stage',
    'Team accounts with approval rules (e.g. PM and finance both approve)',
    'Retention held for the defects period, then released automatically',
    'Independent inspector / QS sign-off before payment',
    'Site diary with location-checked photos',
    'Pay daily or weekly site workers (payroll)',
    'Pay for materials per confirmed delivery',
    'Warranty hold-back (5–10% kept for 30 days after the job)',
    'Create deals by voice note in English, Pidgin, Yoruba, Igbo or Hausa',
    'Get paid early on a locked balance (for a small fee)',
    'Budget dashboard across all my projects',
    'Monthly retainers for freelancers',
  ], { max: 3, required: true });
  para(form, "Anything else you'd want it to do?");
  mc(form, 'Would your business pay a monthly subscription for team tools like these?', [
    'Yes, under ₦25,000', '₦25,000–₦75,000', '₦75,000–₦150,000', 'Over ₦150,000', 'No', "I'm not a business",
  ]);

  // ---------- F. Stay in touch (optional) ----------
  form
    .addPageBreakItem()
    .setTitle('Stay in touch (optional)')
    .setHelpText(
      "Only fill this in if you'd like to try SafeBalance early. We'll only use your details to contact you about the pilot and won't share them."
    );
  mc(form, 'Would you like to try it early in our pilot?', ['Yes', 'Maybe', 'No']);
  short(form, 'Your name');
  short(form, 'Your WhatsApp number');
  para(form, 'Can you introduce us to an association, estate manager or company that might use it? Who?');

  // ---------- Branching ----------
  // After section A, skip B and C. After section B, skip C. (A page break's
  // "go to" applies when someone finishes the section just before it.)
  pageB.setGoToPage(pageD);
  pageC.setGoToPage(pageD);
  role.setChoices([
    role.createChoice('Artisan or tradesperson (electrician, tiler, carpenter, tailor, mechanic, plumber, etc.)', pageA),
    role.createChoice('Freelancer (designer, developer, writer, social media, photographer, etc.)', pageA),
    role.createChoice('Online vendor or seller', pageA),
    role.createChoice('Building contractor or subcontractor', pageB),
    role.createChoice('Project manager, quantity surveyor, engineer or architect', pageB),
    role.createChoice('Estate or facility manager', pageC),
    role.createChoice('I mainly hire workers (homeowner, business owner, building from abroad)', pageC),
  ]);

  // ---------- Responses go to a Google Sheet ----------
  var sheet = SpreadsheetApp.create('SafeBalance survey responses');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  var shareUrl = form.getPublishedUrl();
  try {
    shareUrl = form.shortenFormUrl(shareUrl);
  } catch (e) {
    // Short links aren't available on every account; the long link works the same.
  }
  Logger.log('Share this link: ' + shareUrl);
  Logger.log('Edit the form: ' + form.getEditUrl());
  Logger.log('Responses sheet: ' + sheet.getUrl());
}

// ---------- helpers ----------

function mc(form, title, choices, opts) {
  opts = opts || {};
  var item = form.addMultipleChoiceItem().setTitle(title).setChoiceValues(choices);
  if (opts.other) item.showOtherOption(true);
  if (opts.required) item.setRequired(true);
  return item;
}

function cb(form, title, choices, opts) {
  opts = opts || {};
  var item = form.addCheckboxItem().setTitle(title).setChoiceValues(choices);
  if (opts.other) item.showOtherOption(true);
  if (opts.required) item.setRequired(true);
  if (opts.max) item.setValidation(FormApp.createCheckboxValidation().requireSelectAtMost(opts.max).build());
  return item;
}

function list(form, title, choices) {
  return form.addListItem().setTitle(title).setChoiceValues(choices);
}

function short(form, title, help, required) {
  var item = form.addTextItem().setTitle(title);
  if (help) item.setHelpText(help);
  if (required) item.setRequired(true);
  return item;
}

function para(form, title) {
  return form.addParagraphTextItem().setTitle(title);
}
