# دليل نشر خادم LHTA على Render (خطوة بخطوة)

اخترت لك **Render** لأنه: مجاني للبداية، يوفر قاعدة بيانات PostgreSQL جاهزة بنفس المكان، وأبسط منصة للمبتدئين مقارنة بـ Railway أو إعداد Supabase يدويًا مع كود مخصص.

## 1) ارفع الكود على GitHub
- أنشئ حساب على github.com (لو ما عندك).
- أنشئ مستودع (Repository) جديد وارفع مجلد `lhta-backend` بالكامل إليه.

## 2) أنشئ قاعدة بيانات PostgreSQL
1. سجّل بحساب على render.com (تسجيل مجاني).
2. من لوحة التحكم: **New +** → **PostgreSQL**.
3. اختر اسم للقاعدة، والخطة **Free**.
4. بعد الإنشاء، انسخ قيمة **Internal Database URL**.

## 3) أنشئ خدمة الويب (الخادم نفسه)
1. من لوحة التحكم: **New +** → **Web Service**.
2. اربطه بمستودع GitHub اللي رفعت فيه الكود.
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. اختر الخطة **Free**.

## 4) أضف متغيرات البيئة (Environment Variables)
داخل صفحة الخدمة → تبويب **Environment** → أضف القيم التالية (انسخها من ملف `.env.example`):
- `DATABASE_URL` = القيمة اللي نسختها بالخطوة 2
- `SESSION_SECRET` = أي نص عشوائي طويل (مثلاً 32 حرف عشوائي)
- `ADMIN_PASSWORD` = `Aneslht202700` (أو غيّرها لكلمة أقوى)
- `FRONTEND_URL` = رابط موقعك (لاحقًا بعد رفعه)
- باقي متغيرات Google/Facebook (الخطوة 5 و6)

اضغط **Deploy** — بعد دقيقتين تقريبًا يصير عندك رابط مثل:
`https://lhta-backend.onrender.com`

## 5) إعداد تسجيل الدخول بجوجل (حقيقي)
1. اذهب إلى console.cloud.google.com وأنشئ مشروع جديد.
2. من القائمة: **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**.
3. نوع التطبيق: **Web application**.
4. في **Authorized redirect URIs** ضع بالضبط:
   `https://lhta-backend.onrender.com/api/auth/google/callback`
5. انسخ **Client ID** و **Client Secret** وضعهم في متغيرات البيئة بـ Render (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`).

## 6) إعداد تسجيل الدخول بفيسبوك (حقيقي)
1. اذهب إلى developers.facebook.com → **My Apps** → **Create App** → اختر نوع "Consumer".
2. أضف منتج **Facebook Login** من لوحة المنتجات.
3. في إعدادات Facebook Login، بـ **Valid OAuth Redirect URIs** ضع:
   `https://lhta-backend.onrender.com/api/auth/facebook/callback`
4. من إعدادات التطبيق الأساسية، انسخ **App ID** و **App Secret** وضعهم بمتغيرات البيئة.

## ⚠️ ملاحظة عن إنستغرام
منصات مثل Google وFacebook توفر "تسجيل دخول عام" بسيط لأي زائر. **إنستغرام لا توفر هذا** — تسجيل الدخول عبره مرتبط تقنيًا بحسابات فيسبوك للأعمال (Instagram Business/Facebook Login for Business) ومخصص أساسًا لإدارة صفحات ومحتوى، مو لتسجيل دخول عام للزوار. لذلك:
- **الخيار العملي**: زر "المتابعة عبر Instagram" يفتح صفحتك على إنستغرام بدل تسجيل دخول حقيقي (تسويقي بحت)، بينما يبقى زر فيسبوك هو تسجيل الدخول الفعلي.
- إذا حبيت مستقبلاً ربط حقيقي عبر أعمال، هذا يحتاج حساب Meta Business Suite منفصل ومراجعة إضافية من ميتا.

## 7) تجربة الخادم
افتح `https://lhta-backend.onrender.com` بالمتصفح — لازم يطلع لك:
```json
{"status": "LHTA backend يعمل بنجاح ✅"}
```

## 8) الخطوة الأخيرة
ابعثلي رابط الخادم بعد نشره (مثل `https://lhta-backend.onrender.com`)، وأنا أربط لك موقع LHTA (lhta.html) ليتصل فعليًا بهذا الخادم بدل التخزين المحلي بالمتصفح.

**ملاحظة:** الخطة المجانية بـ Render "تنام" الخدمة بعد 15 دقيقة من عدم الاستخدام، وأول طلب بعدها يأخذ 30-50 ثانية للاستيقاظ. هذا طبيعي بالخطط المجانية ومناسب للتجربة والانطلاقة الأولى؛ لو الموقع كبر وصار عليه زوار حقيقيين، ترقية للخطة المدفوعة ($7/شهر تقريبًا) تحل هذا نهائيًا.
