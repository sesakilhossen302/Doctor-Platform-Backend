/**
 * Demo seed data.
 * - Real Bangladesh administrative divisions/districts (public reference data).
 * - FICTIONAL doctors and hospitals, all flagged isDemo = true so the apps show them as "নমুনা / Demo".
 *   They must never be presented as a real national doctor database.
 * Safe to run multiple times (upserts).
 */
import { ConsultationType, DoctorStatus, FeeMode, FeeServiceType, Gender, Prisma, PrismaClient, Role, VerificationStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
let createdStaffPassword: string | null = null;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const DIVISIONS: [string, string, [string, string][]][] = [
  ['Rangpur', 'রংপুর', [['Rangpur', 'রংপুর'], ['Dinajpur', 'দিনাজপুর'], ['Gaibandha', 'গাইবান্ধা'], ['Kurigram', 'কুড়িগ্রাম'], ['Lalmonirhat', 'লালমনিরহাট'], ['Nilphamari', 'নীলফামারী'], ['Panchagarh', 'পঞ্চগড়'], ['Thakurgaon', 'ঠাকুরগাঁও']]],
  ['Rajshahi', 'রাজশাহী', [['Rajshahi', 'রাজশাহী'], ['Bogura', 'বগুড়া'], ['Joypurhat', 'জয়পুরহাট'], ['Naogaon', 'নওগাঁ'], ['Natore', 'নাটোর'], ['Chapainawabganj', 'চাঁপাইনবাবগঞ্জ'], ['Pabna', 'পাবনা'], ['Sirajganj', 'সিরাজগঞ্জ']]],
  ['Dhaka', 'ঢাকা', [['Dhaka', 'ঢাকা'], ['Faridpur', 'ফরিদপুর'], ['Gazipur', 'গাজীপুর'], ['Gopalganj', 'গোপালগঞ্জ'], ['Kishoreganj', 'কিশোরগঞ্জ'], ['Madaripur', 'মাদারীপুর'], ['Manikganj', 'মানিকগঞ্জ'], ['Munshiganj', 'মুন্সিগঞ্জ'], ['Narayanganj', 'নারায়ণগঞ্জ'], ['Narsingdi', 'নরসিংদী'], ['Rajbari', 'রাজবাড়ী'], ['Shariatpur', 'শরীয়তপুর'], ['Tangail', 'টাঙ্গাইল']]],
  ['Chattogram', 'চট্টগ্রাম', [['Chattogram', 'চট্টগ্রাম'], ['Bandarban', 'বান্দরবান'], ['Brahmanbaria', 'ব্রাহ্মণবাড়িয়া'], ['Chandpur', 'চাঁদপুর'], ["Cox's Bazar", 'কক্সবাজার'], ['Cumilla', 'কুমিল্লা'], ['Feni', 'ফেনী'], ['Khagrachhari', 'খাগড়াছড়ি'], ['Lakshmipur', 'লক্ষ্মীপুর'], ['Noakhali', 'নোয়াখালী'], ['Rangamati', 'রাঙ্গামাটি']]],
  ['Khulna', 'খুলনা', [['Khulna', 'খুলনা'], ['Bagerhat', 'বাগেরহাট'], ['Chuadanga', 'চুয়াডাঙ্গা'], ['Jashore', 'যশোর'], ['Jhenaidah', 'ঝিনাইদহ'], ['Kushtia', 'কুষ্টিয়া'], ['Magura', 'মাগুরা'], ['Meherpur', 'মেহেরপুর'], ['Narail', 'নড়াইল'], ['Satkhira', 'সাতক্ষীরা']]],
  ['Barishal', 'বরিশাল', [['Barishal', 'বরিশাল'], ['Barguna', 'বরগুনা'], ['Bhola', 'ভোলা'], ['Jhalokati', 'ঝালকাঠি'], ['Patuakhali', 'পটুয়াখালী'], ['Pirojpur', 'পিরোজপুর']]],
  ['Sylhet', 'সিলেট', [['Sylhet', 'সিলেট'], ['Habiganj', 'হবিগঞ্জ'], ['Moulvibazar', 'মৌলভীবাজার'], ['Sunamganj', 'সুনামগঞ্জ']]],
  ['Mymensingh', 'ময়মনসিংহ', [['Mymensingh', 'ময়মনসিংহ'], ['Jamalpur', 'জামালপুর'], ['Netrokona', 'নেত্রকোণা'], ['Sherpur', 'শেরপুর']]],
];

const UPAZILAS: Record<string, [string, string, boolean?][]> = {
  Rangpur: [['Rangpur City', 'রংপুর সিটি', true], ['Rangpur Sadar', 'রংপুর সদর'], ['Badarganj', 'বদরগঞ্জ'], ['Gangachara', 'গংগাচড়া'], ['Kaunia', 'কাউনিয়া'], ['Mithapukur', 'মিঠাপুকুর'], ['Pirgachha', 'পীরগাছা'], ['Pirganj', 'পীরগঞ্জ'], ['Taraganj', 'তারাগঞ্জ']],
  Rajshahi: [['Rajshahi City', 'রাজশাহী সিটি', true], ['Paba', 'পবা'], ['Godagari', 'গোদাগাড়ী'], ['Tanore', 'তানোর'], ['Bagha', 'বাঘা'], ['Charghat', 'চারঘাট'], ['Durgapur', 'দুর্গাপুর'], ['Mohanpur', 'মোহনপুর'], ['Puthia', 'পুঠিয়া'], ['Bagmara', 'বাগমারা']],
  Dhaka: [['Dhanmondi', 'ধানমন্ডি', true], ['Mirpur', 'মিরপুর', true], ['Gulshan', 'গুলশান', true], ['Uttara', 'উত্তরা', true], ['Mohammadpur', 'মোহাম্মদপুর', true], ['Savar', 'সাভার'], ['Keraniganj', 'কেরানীগঞ্জ']],
  Chattogram: [['Panchlaish', 'পাঁচলাইশ', true], ['Agrabad', 'আগ্রাবাদ', true], ['Hathazari', 'হাটহাজারী'], ['Patiya', 'পটিয়া']],
  Sylhet: [['Sylhet City', 'সিলেট সিটি', true], ['Beanibazar', 'বিয়ানীবাজার']],
  Khulna: [['Khulna City', 'খুলনা সিটি', true], ['Dumuria', 'ডুমুরিয়া']],
};

const SPECIALTIES: [string, string, string, string][] = [
  ['Medicine', 'মেডিসিন', 'stethoscope', 'General adult medicine, fever, diabetes, blood pressure'],
  ['Cardiology', 'হৃদরোগ', 'heart', 'Heart and blood vessel diseases'],
  ['Gynecology & Obstetrics', 'গাইনী ও প্রসূতি', 'female', 'Women’s health, pregnancy care'],
  ['Pediatrics', 'শিশু রোগ', 'baby', 'Child health from newborn to 18 years'],
  ['Dermatology', 'চর্ম ও যৌন', 'skin', 'Skin, hair and nail problems'],
  ['Orthopedics', 'অর্থোপেডিক্স', 'bone', 'Bones, joints, fractures'],
  ['Neurology', 'নিউরোলজি', 'brain', 'Brain, nerves, headache, stroke'],
  ['ENT', 'নাক কান গলা', 'ear', 'Ear, nose and throat'],
  ['Ophthalmology', 'চক্ষু', 'eye', 'Eye diseases and vision'],
  ['Gastroenterology', 'পরিপাকতন্ত্র', 'stomach', 'Stomach, liver and digestion'],
  ['Psychiatry', 'মানসিক স্বাস্থ্য', 'mind', 'Mental health and wellbeing'],
  ['Nephrology', 'কিডনি', 'kidney', 'Kidney diseases'],
  ['Dentistry', 'দন্ত', 'tooth', 'Teeth and oral health'],
  ['Pulmonology', 'বক্ষব্যাধি', 'lungs', 'Lungs, asthma, breathing'],
];

const DESIGNATIONS: [string, string, number][] = [
  ['Professor & Head of Department', 'অধ্যাপক ও বিভাগীয় প্রধান', 100],
  ['Professor', 'অধ্যাপক', 90],
  ['Associate Professor', 'সহযোগী অধ্যাপক', 80],
  ['Assistant Professor', 'সহকারী অধ্যাপক', 70],
  ['Senior Consultant', 'সিনিয়র কনসালট্যান্ট', 60],
  ['Consultant', 'কনসালট্যান্ট', 50],
  ['Medical Officer', 'মেডিকেল অফিসার', 30],
];

// Fictional names — any resemblance to real people is coincidental.
const FIRST_M = [['Rafiqul', 'রফিকুল'], ['Mahbub', 'মাহবুব'], ['Tanvir', 'তানভীর'], ['Shahidul', 'শহিদুল'], ['Arif', 'আরিফ'], ['Kamrul', 'কামরুল'], ['Nazmul', 'নাজমুল'], ['Imran', 'ইমরান'], ['Sajjad', 'সাজ্জাদ'], ['Faisal', 'ফয়সাল']];
const FIRST_F = [['Nusrat', 'নুসরাত'], ['Farzana', 'ফারজানা'], ['Sharmin', 'শারমিন'], ['Tahmina', 'তাহমিনা'], ['Rumana', 'রুমানা'], ['Nasrin', 'নাসরিন'], ['Sabrina', 'সাবরিনা'], ['Jannatul', 'জান্নাতুল']];
const LAST = [['Islam', 'ইসলাম'], ['Rahman', 'রহমান'], ['Hossain', 'হোসেন'], ['Ahmed', 'আহমেদ'], ['Chowdhury', 'চৌধুরী'], ['Akter', 'আক্তার'], ['Karim', 'করিম'], ['Haque', 'হক'], ['Sarker', 'সরকার'], ['Alam', 'আলম']];
const DEGREES: Record<string, string> = {
  Medicine: 'MBBS, FCPS (Medicine)',
  Cardiology: 'MBBS, MD (Cardiology)',
  'Gynecology & Obstetrics': 'MBBS, FCPS (Gynae & Obs)',
  Pediatrics: 'MBBS, DCH, FCPS (Pediatrics)',
  Dermatology: 'MBBS, DDV',
  Orthopedics: 'MBBS, MS (Ortho)',
  Neurology: 'MBBS, MD (Neurology)',
  ENT: 'MBBS, DLO, FCPS (ENT)',
  Ophthalmology: 'MBBS, DO, FCPS (Eye)',
  Gastroenterology: 'MBBS, MD (Gastroenterology)',
  Psychiatry: 'MBBS, MD (Psychiatry)',
  Nephrology: 'MBBS, MD (Nephrology)',
  Dentistry: 'BDS, FCPS (Dental)',
  Pulmonology: 'MBBS, MD (Chest Diseases)',
};

// Deterministic pseudo-random so every seed run produces the same demo data.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

async function main() {
  console.log('Seeding locations…');
  const districtIds = new Map<string, { id: number; divisionId: number }>();
  for (const [di, [en, bn, districts]] of DIVISIONS.entries()) {
    const division = await prisma.division.upsert({
      where: { slug: slug(en) },
      create: { nameEn: en, nameBn: bn, slug: slug(en), sortOrder: di },
      update: { nameEn: en, nameBn: bn, sortOrder: di },
    });
    for (const [i, [den, dbn]] of districts.entries()) {
      const d = await prisma.district.upsert({
        where: { slug: slug(den) },
        create: { nameEn: den, nameBn: dbn, slug: slug(den), divisionId: division.id, sortOrder: i },
        update: { nameEn: den, nameBn: dbn, divisionId: division.id, sortOrder: i },
      });
      districtIds.set(den, { id: d.id, divisionId: division.id });
    }
  }
  const upazilaIds = new Map<string, number[]>();
  for (const [district, list] of Object.entries(UPAZILAS)) {
    const d = districtIds.get(district)!;
    const ids: number[] = [];
    for (const [i, [en, bn, isCity]] of list.entries()) {
      const s = `${slug(en)}-${d.id}`;
      const u = await prisma.upazila.upsert({
        where: { slug: s },
        create: { nameEn: en, nameBn: bn, slug: s, districtId: d.id, isCity: !!isCity, sortOrder: i },
        update: { nameEn: en, nameBn: bn, isCity: !!isCity, sortOrder: i },
      });
      ids.push(u.id);
    }
    upazilaIds.set(district, ids);
  }

  console.log('Seeding specialties & designations…');
  const specialties = [];
  for (const [i, [en, bn, icon, description]] of SPECIALTIES.entries()) {
    specialties.push(
      await prisma.specialty.upsert({
        where: { slug: slug(en) },
        create: { nameEn: en, nameBn: bn, slug: slug(en), icon, description, sortOrder: i },
        update: { nameEn: en, nameBn: bn, icon, description, sortOrder: i },
      }),
    );
  }
  if ((await prisma.designation.count()) === 0) {
    await prisma.designation.createMany({ data: DESIGNATIONS.map(([nameEn, nameBn, rank]) => ({ nameEn, nameBn, rank })) });
  }
  const designations = await prisma.designation.findMany({ orderBy: { rank: 'desc' } });

  console.log('Seeding platform fees…');
  for (const [serviceType, value] of [
    [FeeServiceType.APPOINTMENT_ONLINE, 20],
    [FeeServiceType.APPOINTMENT_CHAMBER, 20],
    [FeeServiceType.INSTANT_CALL, 10],
  ] as const) {
    await prisma.platformFeeSetting.upsert({
      where: { serviceType },
      create: { serviceType, mode: FeeMode.FIXED, value },
      update: {},
    });
  }

  console.log('Seeding staff accounts…');
  // Local dev DB → the documented demo password. Any other DB (e.g. Railway) → a random strong
  // password unless SEED_ADMIN_PASSWORD is given, because the demo password is public on GitHub.
  const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '');
  const staffPassword = process.env.SEED_ADMIN_PASSWORD ?? (isLocalDb ? 'Admin@12345' : randomBytes(12).toString('base64url'));
  const passwordHash = await bcrypt.hash(staffPassword, 12);
  createdStaffPassword = (await prisma.user.count({ where: { email: 'superadmin@demo.local' } })) === 0 ? staffPassword : null;
  await prisma.user.upsert({
    where: { email: 'superadmin@demo.local' },
    create: { email: 'superadmin@demo.local', name: 'Super Admin', role: Role.SUPER_ADMIN, passwordHash },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: 'admin@demo.local' },
    create: { email: 'admin@demo.local', name: 'Demo Admin', role: Role.ADMIN, passwordHash },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: 'agent@demo.local' },
    create: { email: 'agent@demo.local', name: 'Call Agent', role: Role.CALL_AGENT, passwordHash },
    update: {},
  });

  if ((await prisma.doctor.count({ where: { isDemo: true } })) > 0) {
    console.log('Demo doctors already exist — skipping doctors.');
    await linkDoctorLogins();
    return;
  }

  console.log('Seeding demo hospitals & doctors…');
  const cities = ['Rangpur', 'Rajshahi', 'Dhaka', 'Chattogram', 'Sylhet', 'Khulna', 'Bogura', 'Dinajpur', 'Mymensingh', 'Barishal'];
  const hospitals = [];
  for (const city of cities) {
    const d = districtIds.get(city)!;
    const ups = upazilaIds.get(city);
    for (const [kind, kindBn] of [['Demo City Medical Centre', 'ডেমো সিটি মেডিকেল সেন্টার'], ['Demo Specialized Hospital', 'ডেমো স্পেশালাইজড হাসপাতাল']]) {
      hospitals.push(
        await prisma.hospital.create({
          data: {
            name: `${city} ${kind}`,
            nameBn: `${DIVISIONS.flatMap((x) => x[2]).find(([en]) => en === city)?.[1] ?? city} ${kindBn}`,
            address: `${city} (sample address)`,
            divisionId: d.divisionId,
            districtId: d.id,
            upazilaId: ups?.[0],
          },
        }),
      );
    }
  }

  const COUNT = 60;
  for (let i = 0; i < COUNT; i++) {
    const female = rand() < 0.4;
    const [fEn, fBn] = female ? pick(FIRST_F) : pick(FIRST_M);
    const [lEn, lBn] = pick(LAST);
    const specialty = specialties[i % specialties.length];
    const second = rand() < 0.25 ? specialties[(i + 3) % specialties.length] : undefined;
    const hospital = hospitals[i % hospitals.length];
    const designation = designations[Math.min(designations.length - 1, Math.floor(rand() * designations.length))];
    const experience = 4 + Math.floor(rand() * 26);
    const chamberFee = 300 + Math.round((rand() * 12) | 0) * 100;
    const onlineFee = Math.max(200, chamberFee - 200);
    const types: ConsultationType[] = rand() < 0.75
      ? [ConsultationType.CHAMBER, ConsultationType.ONLINE_AUDIO, ConsultationType.ONLINE_VIDEO]
      : [ConsultationType.CHAMBER];
    const nameEn = `Dr. ${fEn} ${lEn}`;

    const doctor = await prisma.doctor.create({
      data: {
        slug: `${slug(`${fEn} ${lEn}`)}-${i + 1}`,
        nameEn,
        nameBn: `ডা. ${fBn} ${lBn}`,
        gender: female ? Gender.FEMALE : Gender.MALE,
        bio: `${nameEn} is a ${specialty.nameEn.toLowerCase()} specialist with ${experience} years of experience. (Demo profile — fictional doctor for demonstration only.)`,
        degrees: DEGREES[specialty.nameEn] ?? 'MBBS',
        designationId: designation.id,
        experienceYears: experience,
        bmdcNumber: `DEMO-${String(10000 + i)}`,
        languages: rand() < 0.5 ? ['Bangla', 'English'] : ['Bangla'],
        consultationTypes: types,
        chamberFee,
        onlineFee,
        ratingAvg: Math.round((3.8 + rand() * 1.2) * 10) / 10,
        ratingCount: 5 + Math.floor(rand() * 300),
        status: DoctorStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        verifiedAt: new Date(),
        isAvailableNow: types.length > 1 && rand() < 0.4,
        isDemo: true,
        specialties: {
          create: [
            { specialtyId: specialty.id, isPrimary: true },
            ...(second ? [{ specialtyId: second.id, isPrimary: false }] : []),
          ],
        },
        credentials: { create: [{ type: 'BMDC', number: `DEMO-${String(10000 + i)}`, status: VerificationStatus.VERIFIED, notes: 'Demo record' }] },
      },
    });

    const chamber = await prisma.chamber.create({
      data: {
        doctorId: doctor.id,
        hospitalId: hospital.id,
        name: hospital.name,
        address: hospital.address,
        divisionId: hospital.divisionId,
        districtId: hospital.districtId,
        upazilaId: hospital.upazilaId,
      },
    });

    // Chamber: Sat–Thu evenings. Online: Sat–Thu mornings (if offered) and Friday afternoon.
    const evening = rand() < 0.5 ? ['16:00', '20:00'] : ['17:00', '21:00'];
    const schedules: Prisma.DoctorScheduleCreateManyInput[] = [6, 0, 1, 2, 3, 4].map((dayOfWeek) => ({
      doctorId: doctor.id,
      chamberId: chamber.id,
      type: ConsultationType.CHAMBER,
      dayOfWeek,
      startTime: evening[0],
      endTime: evening[1],
      slotMinutes: 15,
    }));
    if (types.includes(ConsultationType.ONLINE_VIDEO)) {
      for (const dayOfWeek of [6, 0, 1, 2, 3, 4]) {
        schedules.push({ doctorId: doctor.id, chamberId: null, type: ConsultationType.ONLINE_VIDEO, dayOfWeek, startTime: '10:00', endTime: '12:00', slotMinutes: 15 });
      }
      schedules.push({ doctorId: doctor.id, chamberId: null, type: ConsultationType.ONLINE_VIDEO, dayOfWeek: 5, startTime: '15:00', endTime: '18:00', slotMinutes: 15 });
    }
    await prisma.doctorSchedule.createMany({ data: schedules });
  }
  console.log(`Created ${COUNT} demo doctors.`);
  await linkDoctorLogins();
}

/**
 * Gives three online demo doctors a doctor-app login (OTP on these numbers) and marks them
 * "available now", so calls and call-center transfers can be tried immediately.
 */
async function linkDoctorLogins() {
  const PHONES = ['01900000001', '01900000002', '01900000003'];
  const already = await prisma.user.count({ where: { phone: { in: PHONES } } });
  if (already === PHONES.length) {
    console.log('Doctor app logins already exist.');
    return;
  }
  const doctors = await prisma.doctor.findMany({
    where: { isDemo: true, userId: null, consultationTypes: { has: ConsultationType.ONLINE_VIDEO } },
    orderBy: { ratingAvg: 'desc' },
    take: PHONES.length,
  });
  for (const [i, d] of doctors.entries()) {
    const user = await prisma.user.upsert({
      where: { phone: PHONES[i] },
      create: { phone: PHONES[i], name: d.nameEn, role: Role.DOCTOR },
      update: {},
    });
    await prisma.doctor.update({ where: { id: d.id }, data: { userId: user.id, isAvailableNow: true } });
    console.log(`  Doctor app login: ${PHONES[i]} → ${d.nameEn}`);
  }
}

main()
  .then(() => {
    console.log('Seed complete ✔');
    if (createdStaffPassword) {
      console.log('\n  Staff logins created (superadmin@demo.local, admin@demo.local, agent@demo.local)');
      console.log(`  Password: ${createdStaffPassword}`);
      console.log('  Save it now — it is not stored anywhere in plain text.\n');
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
