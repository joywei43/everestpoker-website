// Registrations go straight into the Everest member system (Cloudflare Worker + D1).
const API_BASE = (window.EVEREST_API_URL || "https://everest-waiting-api.drumsjw47.workers.dev").replace(/\/$/, "");
const MEMBERS_API_URL = API_BASE + "/register";

const translations = {
  en: {
    title: "Everest Poker Room",
    subtitle: "Member Registration",
    languageLabel: "Language",
    personalInfo: "Personal Information",
    contactInfo: "Contact Information",
    surname: "Surname",
    middleName: "Middle Name",
    familyName: "Given Name",
    nickName: "Nick Name",
    nickNamePlaceholder: "Optional",
    nationality: "Nationality",
    birthday: "Date of Birth",
    passportId: "Passport / ID Number",
    email: "Email",
    phone: "Phone Number",
    referralId: "Referral ID",
    referralPlaceholder: "Optional",
    terms1: "I confirm that the information provided is true and accurate.",
    terms2: "I confirm that I meet the legal age requirement to enter and participate.",
    terms3: "I agree to follow all Everest Poker Room membership rules and house policies.",
    submit: "Submit Registration",
    submitting: "Submitting...",
    requiredMessage: "Please complete all required fields and confirm all terms.",
    successMessage: "Registration submitted successfully.",
    errorMessage: "Submission failed. Please try again or contact staff.",
    ageError: "Members must be 21 years or older.",
    tooManyError: "Too many registrations from this device. Please ask the staff.",
    successTitle: "Thank you for your registration",
    successText1: "Thank you for registering as an Everest Poker Room member.",
    successText2: "We have received your membership registration information.",
    successText3: "Please proceed to the counter with your ID to complete identity verification and receive your member code.",
    closeButton: "Close"
  },

  zh: {
    title: "Everest Poker Room",
    subtitle: "會員註冊",
    languageLabel: "語言",
    personalInfo: "個人資料",
    contactInfo: "聯絡資料",
    surname: "姓氏",
    middleName: "中間名",
    familyName: "名字",
    nickName: "暱稱",
    nickNamePlaceholder: "選填",
    nationality: "國籍",
    birthday: "出生日期",
    passportId: "護照 / 身分證號碼",
    email: "電子信箱",
    phone: "電話號碼",
    referralId: "推薦人 ID",
    referralPlaceholder: "選填",
    terms1: "我確認所提供的資料皆為真實且正確。",
    terms2: "我確認本人符合進入及參與活動之法定年齡要求。",
    terms3: "我同意遵守 Everest Poker Room 會員規則及場館政策。",
    submit: "送出註冊",
    submitting: "送出中...",
    requiredMessage: "請完成所有必填欄位並勾選所有確認項目。",
    successMessage: "註冊資料已成功送出。",
    errorMessage: "送出失敗，請重新嘗試或聯繫現場人員。",
    ageError: "會員須年滿 21 歲。",
    tooManyError: "此裝置送出次數過多，請洽現場人員。",
    successTitle: "感謝您的註冊",
    successText1: "感謝您註冊成為 Everest Poker Room 會員。",
    successText2: "我們已收到您的會員註冊資料。",
    successText3: "請至櫃台提供 ID 完成身份確認並取得會員號碼。",
    closeButton: "關閉"
  },

  ja: {
    title: "Everest Poker Room",
    subtitle: "会員登録",
    languageLabel: "言語",
    personalInfo: "個人情報",
    contactInfo: "連絡先情報",
    surname: "姓",
    middleName: "ミドルネーム",
    familyName: "名",
    nickName: "ニックネーム",
    nickNamePlaceholder: "任意",
    nationality: "国籍",
    birthday: "生年月日",
    passportId: "パスポート / ID 番号",
    email: "メール",
    phone: "電話番号",
    referralId: "紹介者 ID",
    referralPlaceholder: "任意",
    terms1: "入力した情報が真実かつ正確であることを確認します。",
    terms2: "入場および参加に必要な法定年齢を満たしていることを確認します。",
    terms3: "Everest Poker Room の会員規則およびハウスポリシーに同意します。",
    submit: "登録を送信",
    submitting: "送信中...",
    requiredMessage: "必須項目をすべて入力し、確認事項に同意してください。",
    successMessage: "登録情報が送信されました。",
    errorMessage: "送信に失敗しました。再度お試しいただくか、スタッフにお問い合わせください。",
    ageError: "会員は21歳以上である必要があります。",
    tooManyError: "この端末からの送信が多すぎます。スタッフにお問い合わせください。",
    successTitle: "ご登録ありがとうございます",
    successText1: "Everest Poker Room の会員登録ありがとうございます。",
    successText2: "会員登録情報を受け付けました。",
    successText3: "ID を持ってカウンターにお越しいただき、本人確認後に会員番号をお受け取りください。",
    closeButton: "閉じる"
  },

  ko: {
    title: "Everest Poker Room",
    subtitle: "회원 등록",
    languageLabel: "언어",
    personalInfo: "개인 정보",
    contactInfo: "연락처 정보",
    surname: "성",
    middleName: "중간 이름",
    familyName: "이름",
    nickName: "닉네임",
    nickNamePlaceholder: "선택 사항",
    nationality: "국적",
    birthday: "생년월일",
    passportId: "여권 / 신분증 번호",
    email: "이메일",
    phone: "전화번호",
    referralId: "추천인 ID",
    referralPlaceholder: "선택 사항",
    terms1: "제공한 정보가 사실이며 정확함을 확인합니다.",
    terms2: "입장 및 참여를 위한 법적 연령 요건을 충족함을 확인합니다.",
    terms3: "Everest Poker Room 회원 규정 및 하우스 정책을 준수하는 데 동의합니다.",
    submit: "등록 제출",
    submitting: "제출 중...",
    requiredMessage: "모든 필수 항목을 입력하고 확인 사항에 동의해주세요.",
    successMessage: "등록 정보가 성공적으로 제출되었습니다.",
    errorMessage: "제출에 실패했습니다. 다시 시도하거나 직원에게 문의해주세요.",
    ageError: "회원은 만 21세 이상이어야 합니다.",
    tooManyError: "이 기기에서 너무 많이 제출되었습니다. 직원에게 문의해주세요.",
    successTitle: "등록해 주셔서 감사합니다",
    successText1: "Everest Poker Room 회원으로 등록해 주셔서 감사합니다.",
    successText2: "회원 등록 정보를 접수했습니다.",
    successText3: "카운터에서 ID 확인을 완료한 후 회원 번호를 받으시기 바랍니다.",
    closeButton: "닫기"
  },

  th: {
    title: "Everest Poker Room",
    subtitle: "ลงทะเบียนสมาชิก",
    languageLabel: "ภาษา",
    personalInfo: "ข้อมูลส่วนตัว",
    contactInfo: "ข้อมูลติดต่อ",
    surname: "นามสกุล",
    middleName: "ชื่อกลาง",
    familyName: "ชื่อ",
    nickName: "ชื่อเล่น",
    nickNamePlaceholder: "ไม่บังคับ",
    nationality: "สัญชาติ",
    birthday: "วันเกิด",
    passportId: "หมายเลขหนังสือเดินทาง / บัตรประชาชน",
    email: "อีเมล",
    phone: "เบอร์โทรศัพท์",
    referralId: "รหัสผู้แนะนำ",
    referralPlaceholder: "ไม่บังคับ",
    terms1: "ข้าพเจ้ายืนยันว่าข้อมูลที่ให้ไว้เป็นความจริงและถูกต้อง",
    terms2: "ข้าพเจ้ายืนยันว่ามีอายุถึงเกณฑ์ตามกฎหมายสำหรับการเข้าใช้บริการและเข้าร่วมกิจกรรม",
    terms3: "ข้าพเจ้าตกลงปฏิบัติตามกฎสมาชิกและนโยบายของ Everest Poker Room",
    submit: "ส่งข้อมูลลงทะเบียน",
    submitting: "กำลังส่ง...",
    requiredMessage: "กรุณากรอกข้อมูลที่จำเป็นและยืนยันเงื่อนไขทั้งหมด",
    successMessage: "ส่งข้อมูลลงทะเบียนเรียบร้อยแล้ว",
    errorMessage: "ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่หรือติดต่อเจ้าหน้าที่",
    ageError: "สมาชิกต้องมีอายุ 21 ปีขึ้นไป",
    tooManyError: "ส่งข้อมูลจากอุปกรณ์นี้มากเกินไป กรุณาติดต่อเจ้าหน้าที่",
    successTitle: "ขอบคุณสำหรับการลงทะเบียน",
    successText1: "ขอบคุณที่ลงทะเบียนเป็นสมาชิก Everest Poker Room",
    successText2: "เราได้รับข้อมูลการลงทะเบียนสมาชิกของคุณแล้ว",
    successText3: "กรุณานำ ID ไปที่เคาน์เตอร์เพื่อยืนยันตัวตนและรับหมายเลขสมาชิก",
    closeButton: "ปิด"
  },

  vi: {
    title: "Everest Poker Room",
    subtitle: "Đăng ký thành viên",
    languageLabel: "Ngôn ngữ",
    personalInfo: "Thông tin cá nhân",
    contactInfo: "Thông tin liên hệ",
    surname: "Họ",
    middleName: "Tên đệm",
    familyName: "Tên",
    nickName: "Biệt danh",
    nickNamePlaceholder: "Không bắt buộc",
    nationality: "Quốc tịch",
    birthday: "Ngày sinh",
    passportId: "Số hộ chiếu / ID",
    email: "Email",
    phone: "Số điện thoại",
    referralId: "ID người giới thiệu",
    referralPlaceholder: "Không bắt buộc",
    terms1: "Tôi xác nhận rằng thông tin đã cung cấp là đúng và chính xác.",
    terms2: "Tôi xác nhận rằng tôi đáp ứng độ tuổi hợp pháp để vào và tham gia.",
    terms3: "Tôi đồng ý tuân thủ các quy định thành viên và chính sách của Everest Poker Room.",
    submit: "Gửi đăng ký",
    submitting: "Đang gửi...",
    requiredMessage: "Vui lòng hoàn tất các trường bắt buộc và xác nhận tất cả điều khoản.",
    successMessage: "Thông tin đăng ký đã được gửi thành công.",
    errorMessage: "Gửi thất bại. Vui lòng thử lại hoặc liên hệ nhân viên.",
    ageError: "Thành viên phải từ 21 tuổi trở lên.",
    tooManyError: "Thiết bị này đã gửi quá nhiều lần. Vui lòng liên hệ nhân viên.",
    successTitle: "Cảm ơn bạn đã đăng ký",
    successText1: "Cảm ơn bạn đã đăng ký thành viên Everest Poker Room.",
    successText2: "Chúng tôi đã nhận được thông tin đăng ký thành viên của bạn.",
    successText3: "Vui lòng đến quầy cùng với ID để hoàn tất xác minh danh tính và nhận mã thành viên.",
    closeButton: "Đóng"
  }
};

let currentLanguage = "en";

document.addEventListener("DOMContentLoaded", () => {
  const languageSelect = document.getElementById("language");
  const registerForm = document.getElementById("registerForm");
  const closeModalBtn = document.getElementById("closeModalBtn");

  const savedLanguage = localStorage.getItem("everest_register_language");

  if (savedLanguage && translations[savedLanguage]) {
    currentLanguage = savedLanguage;
    languageSelect.value = savedLanguage;
  }

  applyLanguage(currentLanguage);

  languageSelect.addEventListener("change", () => {
    currentLanguage = languageSelect.value;
    localStorage.setItem("everest_register_language", currentLanguage);
    applyLanguage(currentLanguage);
  });

  registerForm.addEventListener("submit", handleSubmit);

  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", closeSuccessModal);
  }
});

function t(key) {
  return translations[currentLanguage]?.[key] || translations.en[key] || key;
}

function applyLanguage(lang) {
  const dict = translations[lang] || translations.en;

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    if (dict[key]) {
      element.textContent = dict[key];
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    if (dict[key]) {
      element.placeholder = dict[key];
    }
  });
}

async function handleSubmit(event) {
  event.preventDefault();

  const form = document.getElementById("registerForm");
  const submitBtn = document.getElementById("submitBtn");
  const formMessage = document.getElementById("formMessage");

  formMessage.textContent = "";
  formMessage.className = "form-message";

  if (!form.checkValidity()) {
    formMessage.textContent = t("requiredMessage");
    formMessage.classList.add("error");
    form.reportValidity();
    return;
  }

  const payload = {
    surname: getValue("surname"),
    middleName: getValue("middleName"),
    familyName: getValue("familyName"),
    nickName: getValue("nickName"),
    nationality: getValue("nationality"),
    birthday: getValue("birthday"),
    passportId: getValue("passportId"),
    email: getValue("email"),
    phone: getValue("phone"),
    whatsapp: getValue("whatsapp"),
    telegram: getValue("telegram"),
    line: getValue("line"),
    referralId: getValue("referralId"),
    agreedTerms: getChecked("agreeTerms"),
    agreedAge: getChecked("agreeAge"),
    agreedPolicy: getChecked("agreePolicy"),
    language: currentLanguage,
    source: "Everest Register Form",
    submittedAt: new Date().toISOString()
  };

  if (!payload.agreedTerms || !payload.agreedAge || !payload.agreedPolicy) {
    formMessage.textContent = t("requiredMessage");
    formMessage.classList.add("error");
    return;
  }

  if (ageFrom(payload.birthday) < 21) {
    formMessage.textContent = t("ageError");
    formMessage.classList.add("error");
    return;
  }

  setSubmitting(true, submitBtn);

  try {
    const response = await fetch(MEMBERS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = response.status === 429 ? t("tooManyError")
        : /21/.test(data.error || "") ? t("ageError")
        : t("errorMessage");
      formMessage.textContent = message;
      formMessage.classList.add("error");
      return;
    }

    form.reset();

    const languageSelect = document.getElementById("language");
    languageSelect.value = currentLanguage;

    formMessage.textContent = t("successMessage");
    formMessage.classList.add("success");

    showSuccessModal();

  } catch (error) {
    console.error("Registration error:", error);
    formMessage.textContent = t("errorMessage");
    formMessage.classList.add("error");
  } finally {
    setSubmitting(false, submitBtn);
  }
}

function ageFrom(birthday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday || "");
  if (!m) return 0;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age--;
  return age;
}

function getValue(id) {
  return document.getElementById(id)?.value?.trim() || "";
}

function getChecked(id) {
  return document.getElementById(id)?.checked || false;
}

function setSubmitting(isSubmitting, button) {
  if (!button) return;

  button.disabled = isSubmitting;

  const span = button.querySelector("span");

  if (span) {
    span.textContent = isSubmitting ? t("submitting") : t("submit");
  } else {
    button.textContent = isSubmitting ? t("submitting") : t("submit");
  }
}

function showSuccessModal() {
  const modal = document.getElementById("successModal");

  if (modal) {
    modal.classList.remove("hidden");
  }
}

function closeSuccessModal() {
  const modal = document.getElementById("successModal");

  if (modal) {
    modal.classList.add("hidden");
  }
}
