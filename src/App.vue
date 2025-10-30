<script setup>
import { ref, watchEffect, nextTick, computed } from 'vue';
import { XMarkIcon } from "@heroicons/vue/24/outline";
import ConversationList from './components/ConversationList.vue';
import MessageView from './components/MessageView.vue';
import PrivacyPolicy from './components/PrivacyPolicy.vue';
import {
  getGoogleContacts,
  initiateGoogleLogin,
  logoutFromGoogle,
  checkGoogleAuthStatus
} from './services/google.service';
import {
  login as apiLogin,
  getSession as apiGetSession,
  getIncomingSms,
  getSmsOutLog,
  getTextFile,
  uploadTextFile,
  mfaIsPass,
  mfaTry,
  mfaGetMethods,
  mfaSend,
  mfaValidate,
  getStoredToken,
  setStoredToken
} from './services/api.service';

const openPrivacyPolicy = () => {
  window.openPrivacyPolicy()
};

const conversations = ref([]);

const selectedConversationId = ref(null);
const selectedConversation = ref(null);

const loginDialogVisible = ref(false);
const username = ref(localStorage.getItem('username') || '');
const password = ref('');
const usernameFocus = ref(false);
const loading = ref(false);
const error = ref('');

// MFA + Token state
const mfaDialogVisible = ref(false);
const mfaLoading = ref(false);
const mfaError = ref('');
const mfaMethods = ref([]);
const selectedMfaId = ref(null);
const selectedSendType = ref(null);
const mfaCode = ref('');
const rememberMe = ref(true);
const rememberNote = ref('SMS App');
const apiToken = ref(getStoredToken());
const isSessionReady = ref(false);
let newMessagesIntervalId = null;
const isMfaStep = ref(false);
// MFA sub-stages: 'choose' methods grid, or 'code' entry screen
const mfaStage = ref('choose');
const mfaSending = ref(false);
const mfaSentTo = ref({ methodId: null, sendType: null, label: '', destination: '' });
const mfaCooldownSeconds = ref(0);
let mfaCooldownTimer = null;
const mfaValidateDetails = ref(null);

// Only show active methods to avoid empty cards when filtering in template
const activeMfaMethods = computed(() => (mfaMethods.value || []).filter(m => m.STATUS === 'ACTIVE'));
// Stable reversed copy (non-mutating) if we ever want reversed order
const reversedActiveMfaMethods = computed(() => [...activeMfaMethods.value].reverse());

// Dynamic dialog titles/subtitles per stage
const dialogTitle = computed(() => {
  if (!isMfaStep.value) return 'התחברות למערכת';
  return mfaStage.value === 'choose' ? 'שליחת קוד אימות דו שלבי' : 'אימות הקוד';
});

const dialogSubtitle = computed(() => {
  if (!isMfaStep.value) return 'הזן את פרטי ההתחברות שלך כדי להתחיל';
  return mfaStage.value === 'choose'
    ? 'אנא בחר את הדרך בו תרצה לקבל קוד אימות'
    : 'אנא הזן את הקוד שקיבלת';
});

function mfaNikeLabel(method) {
  const map = {
    CREATE_PHONE: 'המספר שיצר את המערכת',
    RESET_MAIL: 'דוא"ל לשחזור',
    PROFILE: 'הגיע מהפרופיל הקבוע',
    MASTER_LOGIN: 'התחברות מאסטר של ריסיילר',
    BY_CUSTOMER: 'נוסף על ידי הלקוח'
  };
  return map[method?.NIKE] || method?.NOTE || 'שיטת אימות';
}

function mfaNikeDescription(method) {
  // תיאור נוסף אינו נדרש כשכותרת כבר מציגה עברית מלאה, נשאיר רק NOTE במידת הצורך
  return '';
}

async function prepareMfa(token) {
  try {
    mfaError.value = '';
    mfaLoading.value = true;
    await mfaTry(token);
    const methodsRes = await mfaGetMethods(token);
    if (methodsRes?.mfaMethods && Array.isArray(methodsRes.mfaMethods)) {
      mfaMethods.value = methodsRes.mfaMethods;
      const active = mfaMethods.value.find(m => m.STATUS === 'ACTIVE');
      selectedMfaId.value = active?.ID ?? null;
      selectedSendType.value = (active?.SEND_TYPE || [])[0] || null;
    } else {
      mfaMethods.value = [];
    }
  } catch (e) {
    console.error('prepareMfa error', e);
    mfaError.value = 'שגיאה בטעינת אפשרויות האימות';
  } finally {
    mfaLoading.value = false;
  }
}

async function sendMfaCode(mfaIdParam, sendTypeParam) {
  try {
    mfaError.value = '';
    mfaLoading.value = true;
    mfaSending.value = true;
    const token = apiToken.value || getStoredToken();
    const mfaIdToUse = mfaIdParam ?? selectedMfaId.value;
    const sendTypeToUse = sendTypeParam ?? selectedSendType.value;
    if (!mfaIdToUse || !sendTypeToUse) {
      mfaError.value = 'בחרו שיטה ואופן שליחה';
      return;
    }
    const res = await mfaSend(token, { mfaId: mfaIdToUse, mfaSendType: sendTypeToUse, lang: 'HE' });
    if (res?.responseStatus !== 'OK') {
      const msg = res?.message || 'שגיאה בשליחת קוד';
      mfaError.value = msg;
      // handle cooldown: "wait 25s"
      const match = /wait\s+(\d+)s/i.exec(msg);
      if (match) {
        mfaCooldownSeconds.value = parseInt(match[1], 10) || 0;
        if (mfaCooldownTimer) clearInterval(mfaCooldownTimer);
        if (mfaCooldownSeconds.value > 0) {
          mfaCooldownTimer = setInterval(() => {
            if (mfaCooldownSeconds.value > 0) mfaCooldownSeconds.value -= 1;
            else {
              clearInterval(mfaCooldownTimer);
              mfaCooldownTimer = null;
            }
          }, 1000);
        }
      }
    } else {
      // move to code-only stage and remember where we sent it
      const method = mfaMethods.value.find(x => x.ID === mfaIdToUse);
      mfaSentTo.value = {
        methodId: mfaIdToUse,
        sendType: sendTypeToUse,
        label: method ? mfaNikeLabel(method) : '',
        destination: method?.VALUE || ''
      };
      mfaStage.value = 'code';
    }
  } catch (e) {
    console.error('sendMfaCode error', e);
    mfaError.value = 'שגיאה בשליחת קוד';
  } finally {
    mfaLoading.value = false;
    mfaSending.value = false;
  }
}

async function validateMfaCode() {
  try {
    mfaError.value = '';
    mfaLoading.value = true;
    mfaSending.value = true;
    const token = apiToken.value || getStoredToken();
    const res = await mfaValidate(token, { mfaCode: mfaCode.value, mfaRememberMe: rememberMe.value, mfaRememberNote: rememberNote.value });

    if (res?.responseStatus === 'OK' && res?.mfa_valid_status === 'VALID') {
      mfaValidateDetails.value = null;
      const sessionRes = await apiGetSession(token);
      if (sessionRes?.responseStatus === 'OK') {
        mfaDialogVisible.value = false;
        isMfaStep.value = false;
        loginDialogVisible.value = false;
        isSessionReady.value = true;
        await getMessages();
        if (!newMessagesIntervalId) newMessagesIntervalId = setInterval(checkNewMessages, 5000);
      } else {
        mfaError.value = 'האימות הצליח אך הסשן לא תקין, נסו שוב';
      }
    } else if (res?.responseStatus === 'OK' && (res?.mfa_valid_status === 'UNVALID' || res?.mfa_valid_status === 'OVERTRY')) {
      if (res?.mfa_valid_status === 'OVERTRY') {
        mfaValidateDetails.value = null;
        mfaError.value = 'עבר מספר הנסיונות המותר. יש לשלוח קוד חדש.';
      } else {
        // UNVALID: show compact message per requirement
        const left = (res?.mfa_valid_left ?? '').toString();
        const trys = (res?.mfa_valid_trys ?? '').toString();
        mfaValidateDetails.value = null;
        mfaError.value = `קוד האימות שגוי! נותרו לך ${left} ניסיונות | ניסיון ${trys}`;
      }
    } else {
      mfaError.value = res?.mfa_valid_message || 'קוד לא תקין';
    }
  } catch (e) {
    console.error('validateMfaCode error', e);
    mfaError.value = 'שגיאה באימות הקוד';
  } finally {
    mfaLoading.value = false;
    mfaSending.value = false;
  }
}

const setRead = ref(null);

const googleAuthStatus = ref({
  isAuthenticated: false,
  userEmail: '',
  contactCount: 0
});

const isLoadingContacts = ref(false);

const handleConversationSelect = (id) => {
  console.log('Selected conversation ID:', id);

  setRead.value = null;

  selectedConversationId.value = String(id);
  selectedConversation.value = conversations.value.find(c => String(c.id) === String(id)) || null;

  console.log('After select - selectedId:', selectedConversationId.value);
  console.log('Found conversation:', selectedConversation.value ? selectedConversation.value.id : 'none');

  watchEffect(() => {
    nextTick(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
  }, {
    flush: 'post'
  });

  setRead.value = setTimeout(async () => {
    const readedArray = [];
    const incomingMessages = selectedConversation.value.messages.filter(message => message.type === 'incoming');

    incomingMessages.forEach((message) => {
      if (!message.read) {
        readedArray.push({
          phone: message.sender,
          message: message.message,
          server_date: new Date(message.timestamp).getTime()
        });
      }
    });

    if (readedArray.length > 0) {
      try {
        const token = apiToken.value || getStoredToken();
        const readedMessagesRes = await getTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini');
        let readedMessages = [];

        if (readedMessagesRes.message === "file does not exist") {
          await uploadTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini', readedArray);
        } else {
          const readedMessagesData = readedMessagesRes.contents;
          const readedMessagesObj = JSON.parse(readedMessagesData);

          readedMessages = readedMessagesObj;
          readedMessages = readedMessages.concat(readedArray);

          await uploadTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini', readedMessages);

          conversations.value = conversations.value.map(conversation => {
            if (conversation.id === id) {
              conversation.unreadCount = 0;
            }
            return conversation;
          });
        }
      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    }
  }, 1000);
};

async function init() {
  document.title = 'מערכת סמסים';

  // clear any running interval on load
  if (newMessagesIntervalId) {
    clearInterval(newMessagesIntervalId);
    newMessagesIntervalId = null;
  }

  if (!apiToken.value) {
    isSessionReady.value = false;
    loginDialogVisible.value = true;
    isMfaStep.value = false;
    mfaStage.value = 'choose';
    usernameFocus.value = true;
    return;
  }

  // Verify token session first
  try {
    const sessionRes = await apiGetSession(apiToken.value);
    if (sessionRes?.responseStatus === 'OK') {
      isSessionReady.value = true;
    } else if (sessionRes?.responseStatus === 'FORBIDDEN' && sessionRes?.message === 'MFA_REQUIRED') {
      isSessionReady.value = false;
      loginDialogVisible.value = true;
      isMfaStep.value = true;
      mfaStage.value = 'choose';
      await prepareMfa(apiToken.value);
      return;
    } else {
      isSessionReady.value = false;
      loginDialogVisible.value = true;
      isMfaStep.value = false;
      return;
    }
  } catch (e) {
    console.error('Session check failed', e);
    isSessionReady.value = false;
    loginDialogVisible.value = true;
    return;
  }

  try {
    const status = await checkGoogleAuthStatus();
    googleAuthStatus.value = status;
    window.dispatchEvent(new CustomEvent('googleAuthStatusUpdated'));
  } catch (error) {
    console.error('Error checking Google auth status during init:', error);
  }

  if (isSessionReady.value) {
    await getMessages();
    if (!localStorage.getItem('lastIncomingMessage')) {
      localStorage.setItem('lastIncomingMessage', '');
    }
    if (!localStorage.getItem('lastOutgoingMessage')) {
      localStorage.setItem('lastOutgoingMessage', '');
    }
    newMessagesIntervalId = setInterval(checkNewMessages, 5000);
  }
}

async function checkNewMessages() {
  try {
    if (!isSessionReady.value) return;
    const token = apiToken.value || getStoredToken();

    // בדיקת הודעות נכנסות חדשות
    const incomingData = await getIncomingSms(token, 1);
    const incomingMessage = incomingData.rows[0];

    const lastIncomingMessage = localStorage.getItem('lastIncomingMessage');
    if (lastIncomingMessage !== JSON.stringify(incomingMessage)) {
      if (incomingMessage) {
        new Notification(
          incomingMessage.source.startsWith('972') ? '0' + incomingMessage.source.substring(3) : incomingMessage.source,
          { body: incomingMessage.message }
        );
        localStorage.setItem('lastIncomingMessage', JSON.stringify(incomingMessage));
      }
    }

    // בדיקת הודעות יוצאות חדשות
    const outgoingData = await getSmsOutLog(token, 1);
    const outgoingMessage = outgoingData.rows[0];

    const lastOutgoingMessage = localStorage.getItem('lastOutgoingMessage');
    if (lastOutgoingMessage !== JSON.stringify(outgoingMessage)) {
      if (outgoingMessage) {
        localStorage.setItem('lastOutgoingMessage', JSON.stringify(outgoingMessage));
      }
    }

    // רענון ההודעות רק אם יש הודעות חדשות
    if (lastIncomingMessage !== JSON.stringify(incomingMessage) || lastOutgoingMessage !== JSON.stringify(outgoingMessage)) {
      await refreshMessages();
    }
  } catch (error) {
    console.error('Error checking for new messages:', error);
  }
}

async function getMessages() {
  try {
    if (!isSessionReady.value) return;
    console.log('Getting messages and refreshing data...');

    const token = apiToken.value || getStoredToken();
    const incomingRes = await getIncomingSms(token, 3000);
    const outgoingRes = await getSmsOutLog(token, 999999);

    let contacts = {};

    // פונקציה לניקוי פורמט מספר טלפון
    const normalizePhoneNumber = (phone) => {
      if (!phone) return '';
      let clean = phone.replace(/\D/g, '');
      if (clean.startsWith('972')) {
        clean = '0' + clean.substring(3);
      }
      return clean;
    };

    isLoadingContacts.value = true;
    const googleContactsResult = await getGoogleContacts();
    isLoadingContacts.value = false;

    if (googleContactsResult.isAuthenticated && googleContactsResult.contacts) {
      console.log('Processing Google contacts:', googleContactsResult.contacts.length);
      googleContactsResult.contacts.forEach(contact => {
        if (contact.phone && contact.name) {
          const cleanPhone = normalizePhoneNumber(contact.phone);
          contacts[cleanPhone] = {
            name: contact.name,
            avatar: contact.avatar
          };
          console.log(`Mapped contact: ${contact.phone} -> ${cleanPhone} -> ${contact.name}`);
        }
      });
      console.log('Final contacts mapping:', Object.keys(contacts).length, 'contacts mapped');
      console.log('Available contact numbers:', Object.keys(contacts));
      console.log('Sample contacts:', Object.entries(contacts).slice(0, 5));

      googleAuthStatus.value = {
        isAuthenticated: true,
        userEmail: googleContactsResult.userData?.email || '',
        contactCount: googleContactsResult.contacts.length
      };
    } else {
      googleAuthStatus.value = {
        isAuthenticated: false,
        userEmail: '',
        contactCount: 0
      };
    }

    const readedMessagesRes = await getTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini');
    let readedMessages = [];

    if (readedMessagesRes.message === "file does not exist") {
      await uploadTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini', []);
    } else {
      const readedMessagesData = readedMessagesRes.contents;
      const readedMessagesObj = JSON.parse(readedMessagesData);
      readedMessages = readedMessagesObj;
    }

    const incomingMsgs = incomingRes.rows || [];
    const outgoingMsgs = outgoingRes.rows || [];

    const incomingMessages = incomingMsgs.map((message) => {
      console.log('Processing incoming message from:', message.source, 'to:', message.destination);
      const phone = message.source.startsWith('972') ? '0' + message.source.substring(3) : message.source;
      // עבור הודעות נכנסות, הזיהוי יוצא הוא destination עם החלפת 972 ב-0
      const callerId = message.destination.startsWith('972') ? '0' + message.destination.substring(3) : message.destination;
      return {
        ...message,
        dest: message.destination,
        phone: phone,
        server_date: message.receive_date,
        type: 'incoming',
        status: 'DELIVRD',
        callerId: callerId // הוסף את הזיהוי יוצא להודעות נכנסות
      };
    });

    const outgoingMessages = outgoingMsgs.map((message) => {
      console.log('Processing outgoing message to:', message.To, 'from:', message.CallerId);
      return {
        dest: message.CallerId,
        phone: message.To,
        message: message.Message,
        server_date: message.Time,
        status: message.DeliveryReport,
        type: 'outgoing',
        callerId: message.CallerId // שמור את הזיהוי יוצא מהודעות יוצאות
      };
    });

    // שמירת ההודעות האחרונות ב-localStorage
    if (incomingMsgs.length > 0) {
      localStorage.setItem('lastIncomingMessage', JSON.stringify(incomingMsgs[0]));
    }
    if (outgoingMsgs.length > 0) {
      localStorage.setItem('lastOutgoingMessage', JSON.stringify(outgoingMsgs[0]));
    }
    conversations.value = [];

    let messages = incomingMessages.concat(outgoingMessages);
    messages.sort((a, b) => new Date(b.server_date) - new Date(a.server_date));

    const messagesBySender = messages.reduce((acc, message) => {
      const sender = message.phone;
      if (!acc[sender]) {
        acc[sender] = [];
      }
      acc[sender].push(message);
      return acc;
    }, {});

    const usedIds = new Set();

    console.log('Conversation phone numbers:', messages.map(m => m.phone).filter((v, i, a) => a.indexOf(v) === i));
    
    for (let conversation of removeDuplicates(messages, 'phone')) {
      const lastMessageData = messagesBySender[conversation.phone][0];

      let uniqueId = crypto.randomUUID();
      while (usedIds.has(uniqueId)) {
        uniqueId = crypto.randomUUID();
      }
      usedIds.add(uniqueId);

      const msgs = messagesBySender[conversation.phone].reverse().map((message) => {
        let msgUniqueId = crypto.randomUUID();
        while (usedIds.has(msgUniqueId)) {
          msgUniqueId = crypto.randomUUID();
        }
        usedIds.add(msgUniqueId);

        return {
          id: msgUniqueId,
          sender: message.phone,
          content: message.message,
          timestamp: new Date(message.server_date),
          read: readedMessages.some(readedMessage =>
            readedMessage.phone === message.phone &&
            readedMessage.message === message.message &&
            readedMessage.server_date === new Date(message.server_date).getTime()
          ),
          avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + message.phone,
          type: message.type,
          status: message.status,
          callerId: message.callerId, // שמור את הזיהוי יוצא
        };
      });

      let lastMsgUniqueId = crypto.randomUUID();
      while (usedIds.has(lastMsgUniqueId)) {
        lastMsgUniqueId = crypto.randomUUID();
      }
      usedIds.add(lastMsgUniqueId);

      // ניקוי פורמט המספר לשיחה
      const cleanConversationPhone = normalizePhoneNumber(conversation.phone);
      
      // נסה למצוא התאמה במספרים שונים
      let contactInfo = contacts[cleanConversationPhone];
      if (!contactInfo) {
        // נסה עם 972 במקום 0
        const with972 = '972' + cleanConversationPhone.substring(1);
        contactInfo = contacts[with972];
      }
      if (!contactInfo) {
        // נסה עם +972
        const withPlus972 = '+972' + cleanConversationPhone.substring(1);
        contactInfo = contacts[withPlus972];
      }
      if (!contactInfo) {
        // נסה למצוא התאמה חלקית - רק 9 הספרות האחרונות
        const last9Digits = cleanConversationPhone.slice(-9);
        for (const [phone, info] of Object.entries(contacts)) {
          if (phone.endsWith(last9Digits)) {
            contactInfo = info;
            console.log(`Found partial match: ${phone} matches ${cleanConversationPhone}`);
            break;
          }
        }
      }
      if (!contactInfo) {
        // נסה למצוא התאמה עם מספרים שונים
        for (const [phone, info] of Object.entries(contacts)) {
          const normalizedPhone = normalizePhoneNumber(phone);
          if (normalizedPhone === cleanConversationPhone) {
            contactInfo = info;
            console.log(`Found normalized match: ${phone} -> ${normalizedPhone} matches ${cleanConversationPhone}`);
            break;
          }
        }
      }
      
      // קבע את השם והתמונה
      let contactName = conversation.phone;
      let contactAvatar = 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + conversation.phone;
      
      if (contactInfo) {
        if (typeof contactInfo === 'string') {
          // תמיכה בפורמט הישן
          contactName = contactInfo;
        } else {
          // פורמט חדש עם שם ותמונה
          contactName = contactInfo.name;
          contactAvatar = contactInfo.avatar;
        }
      }
      
      console.log(`Creating conversation for ${conversation.phone} (cleaned: ${cleanConversationPhone}): found contact name: ${contactName}`);
      console.log(`Available contacts for matching:`, Object.keys(contacts));
      console.log(`Looking for match for: ${cleanConversationPhone}`);
      console.log(`Contact mapping:`, contacts);
      
      conversations.value.push({
        id: String(uniqueId),
        contact: conversation.phone,
        name: contactName,
        avatar: contactAvatar,
        lastMessage: {
          id: lastMsgUniqueId,
          sender: lastMessageData.phone,
          content: lastMessageData.message,
          timestamp: new Date(lastMessageData.server_date),
          read: readedMessages.some(readedMessage =>
            readedMessages.phone === lastMessageData.phone &&
            readedMessages.message === lastMessageData.message &&
            readedMessages.server_date === new Date(lastMessageData.server_date).getTime()
          ),
          avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + lastMessageData.phone,
          type: lastMessageData.type,
          status: lastMessageData.status,
          callerId: lastMessageData.callerId, // שמור את הזיהוי יוצא
        },
        messages: msgs,
        unreadCount: msgs.filter((message) => message.type == 'incoming' && message.read == false).length,
      });
    }

    console.log('Created conversations:', conversations.value.map(c => ({ id: c.id, name: c.name, contact: c.contact })));

    window.dispatchEvent(new CustomEvent('googleAuthStatusUpdated'));
  } catch (err) {
    console.error('Error getting messages:', err);
  }
}

async function login() {
  loading.value = true;
  error.value = '';

  if (!username.value || !password.value) {
    error.value = 'כל השדות הינם שדות חובה!';
    loading.value = false;
    return;
  }

  try {
    // Step 1: Login to get token
    const loginRes = await apiLogin(username.value, password.value);
    if (!loginRes || !loginRes.token) {
      throw new Error(loginRes?.message || 'Login failed');
    }

    // Store token
    setStoredToken(loginRes.token);
    apiToken.value = loginRes.token;

    // Step 2: Check session
    const sessionRes = await apiGetSession(loginRes.token);

    if (sessionRes?.responseStatus === 'OK') {
      loginDialogVisible.value = false;
      isSessionReady.value = true;

      // האם להחליף את init בתהליך התחברות ספציפי יותר?
      // בדוק סטטוס גוגל לפני קבלת הודעות
      console.log('Successfully logged in, checking Google auth status...');

      try {
        const status = await checkGoogleAuthStatus();
        googleAuthStatus.value = status;
        console.log('Google auth status after login:', status);

        // הודע לכל הרכיבים על עדכון סטטוס האימות
        window.dispatchEvent(new CustomEvent('googleAuthStatusUpdated'));
      } catch (googleError) {
        console.error('Error checking Google status after login:', googleError);
      }

      // Ready
      await getMessages();
      if (!newMessagesIntervalId) newMessagesIntervalId = setInterval(checkNewMessages, 5000);
      
      // הגדרת ערכים ראשוניים ל-localStorage אם לא קיימים
      if (!localStorage.getItem('lastIncomingMessage')) {
        localStorage.setItem('lastIncomingMessage', '');
      }
      if (!localStorage.getItem('lastOutgoingMessage')) {
        localStorage.setItem('lastOutgoingMessage', '');
      }
      
      setInterval(checkNewMessages, 5000);

    } else if (sessionRes?.responseStatus === 'FORBIDDEN' && sessionRes?.message === 'MFA_REQUIRED') {
      // MFA flow
      loginDialogVisible.value = true;
      isSessionReady.value = false;
      isMfaStep.value = true;
      mfaStage.value = 'choose';
      await prepareMfa(loginRes.token);
    } else {
      error.value = 'שגיאה בהתחברות: ' + (sessionRes?.message || '');
    }
  } catch (err) {
    error.value = 'שגיאת התחברות. אנא נסה שוב מאוחר יותר.';
    console.error('Login error:', err);
  } finally {
    loading.value = false;
  }
}

async function refreshMessages() {
  const phone = selectedConversation.value?.contact;
  await getMessages();

  if (phone) {
    handleConversationSelect(conversations.value.find(c => c.contact === phone)?.id || '');
  }
}

function filterConversations(filter) {
  const filtered = conversations.value.filter(conversation => conversation.unreadCount > 0);

  if (!filtered.length) return;

  if (filter) {
    conversations.value = filtered;
  } else {
    getMessages();
  }
}

// Request notification permissions
if ('Notification' in window && Notification.requestPermission) {
  Notification.requestPermission().then((permission) => {
    if (permission === 'granted') {
      console.log('Notification permission granted.');
    } else {
      console.error('Notification permission denied.');
    }
  });
} else {
  console.error('Notifications are not supported by this browser.');
}

// Initialize the application
init();

// הוספת פונקציית removeDuplicates
function removeDuplicates(array, key) {
  return Array.from(
    new Map(array.map((item) => [item[key], item])).values()
  );
}

// Listen for authentication status changes
window.addEventListener('googleAuthStatusChanged', async () => {
  console.log('Google auth status changed, refreshing data...');
  await getMessages();
});

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    console.log('Text copied to clipboard');
  }).catch(err => {
    console.error('Error copying text: ', err);
  });
}

async function markAllAsRead() {
  try {
    // איסוף כל ההודעות הנכנסות שלא נקראו
    const allUnreadMessages = [];
    
    conversations.value.forEach(conversation => {
      const unreadIncomingMessages = conversation.messages.filter(
        message => message.type === 'incoming' && !message.read
      );
      
      unreadIncomingMessages.forEach(message => {
        console.log(message)
        allUnreadMessages.push({
          phone: message.sender,
          message: message.content,
          server_date: new Date(message.timestamp).getTime()
        });
      });
    });

    if (allUnreadMessages.length === 0) {
      console.log('No unread messages to mark as read');
      return;
    }

    // קבלת ההודעות הנקראות הקיימות
    const token = apiToken.value || getStoredToken();
    const readedMessagesRes = await getTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini');
    let readedMessages = [];

    if (readedMessagesRes.message === "file does not exist") {
      // אם הקובץ לא קיים, צור אותו עם כל ההודעות הלא נקראות
      await uploadTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini', allUnreadMessages);
    } else {
      // אם הקובץ קיים, הוסף את ההודעות החדשות
      const readedMessagesData = readedMessagesRes.contents;
      readedMessages = JSON.parse(readedMessagesData);
      readedMessages = readedMessages.concat(allUnreadMessages);

      // עדכן את הקובץ עם כל ההודעות הנקראות
      await uploadTextFile(token, 'ivr2:YemotSMSInboxReadedMessages.ini', readedMessages);
    }

    // עדכן את כל השיחות מקומית - אפס את מונה ההודעות הלא נקראות
    conversations.value = conversations.value.map(conversation => ({
      ...conversation,
      unreadCount: 0,
      messages: conversation.messages.map(message => ({
        ...message,
        read: message.type === 'incoming' ? true : message.read
      }))
    }));

    // עדכן את השיחה הנבחרת אם קיימת
    if (selectedConversation.value) {
      selectedConversation.value = {
        ...selectedConversation.value,
        unreadCount: 0,
        messages: selectedConversation.value.messages.map(message => ({
          ...message,
          read: message.type === 'incoming' ? true : message.read
        }))
      };
    }

    console.log(`Marked ${allUnreadMessages.length} messages as read`);
    
  } catch (error) {
    console.error('Error marking all messages as read:', error);
    alert('שגיאה בסימון ההודעות כנקראו');
  }
}
</script>

<template>
  <div class="flex h-full bg-gray-50 relative">
    <MessageView :conversation="selectedConversation" @refresh-messages="refreshMessages" :username="username"
      :selected-id="selectedConversationId" @back="selectedConversation = null, selectedConversationId = null" />

    <ConversationList :conversations="conversations" :selected-id="selectedConversationId"
      :is-loading-contacts="isLoadingContacts"
      @select="handleConversationSelect" @refresh-messages="refreshMessages" @filter="filterConversations" 
      @mark-all-as-read="markAllAsRead" />
  </div>

  <!-- <Google /> -->

  <!-- Login Dialog -->
  <transition name="fade">
    <div v-if="loginDialogVisible"
      class="fixed inset-0 bg-gray-900 bg-opacity-50 flex justify-center items-center z-50 p-4"
      style="backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);">

      <div class="bg-white p-8 rounded-xl shadow-xl w-full max-w-3xl relative" @click.stop>
        <div v-if="mfaSending" class="absolute inset-0 bg-white bg-opacity-80 flex items-center justify-center z-10">
          <div class="flex flex-col items-center gap-3">
            <svg class="animate-spin h-8 w-8 text-indigo-600" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <div class="text-sm text-gray-700">שולח/מאמת מול השרת...</div>
          </div>
        </div>
        <div class="flex flex-col items-center mb-6">
          <div class="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-indigo-600" fill="none" viewBox="0 0 24 24"
              stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <h3 class="text-2xl font-bold text-gray-800">{{ dialogTitle }}</h3>
          <p class="text-gray-500 mt-1 text-center">{{ dialogSubtitle }}</p>
        </div>

        <div v-if="error" class="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {{ error }}
        </div>

        <div v-if="!isMfaStep" class="space-y-4">
          <label for="username"
            class="relative block overflow-hidden rounded-lg border border-gray-200 px-3 pt-3 shadow-sm focus-within:border-indigo-600 focus-within:ring-1 focus-within:ring-indigo-600 transition-colors cursor-text">
            <input v-model="username" type="text" id="username" placeholder="מה מספר המערכת שלך?"
              :autofocus="usernameFocus" @keydown.enter="login()"
              class="peer h-10 w-full border-none bg-transparent p-0 placeholder-transparent focus:placeholder-gray-400 focus:border-transparent focus:outline-none focus:ring-0 sm:text-sm text-gray-900" />
            <span
              class="absolute start-3 top-3 -translate-y-1/2 text-xs text-gray-500 transition-all peer-placeholder-shown:top-1/2 peer-placeholder-shown:text-sm peer-focus:top-3 peer-focus:text-xs">
              מספר מערכת
            </span>
          </label>

          <label for="password"
            class="relative block overflow-hidden rounded-lg border border-gray-200 px-3 pt-3 shadow-sm focus-within:border-indigo-600 focus-within:ring-1 focus-within:ring-indigo-600 transition-colors cursor-text">
            <input v-model="password" type="password" id="password" placeholder="מה הסיסמא שלך?"
              @keydown.enter="login()"
              class="peer h-10 w-full border-none bg-transparent p-0 placeholder-transparent focus:placeholder-gray-400 focus:border-transparent focus:outline-none focus:ring-0 sm:text-sm text-gray-900" />
            <span
              class="absolute start-3 top-3 -translate-y-1/2 text-xs text-gray-500 transition-all peer-placeholder-shown:top-1/2 peer-placeholder-shown:text-sm peer-focus:top-3 peer-focus:text-xs">
              סיסמא
            </span>
          </label>

          <button :disabled="loading" @click="login()" :class="[
            loading ? 'bg-opacity-70 cursor-not-allowed' : 'hover:bg-indigo-500',
            'mt-6 transition-all w-full px-4 py-3 text-white bg-indigo-600 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 font-medium'
          ]">
            <span v-if="!loading">כניסה למערכת</span>
            <span v-else class="flex justify-center items-center">
              <svg class="animate-spin -mr-1 ml-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none"
                viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z">
                </path>
              </svg>
              בודק את הפרטים...
            </span>
          </button>

          <div class="text-sm text-center pt-2 text-indigo-600">
            <span class="hover:underline cursor-pointer" @click="openPrivacyPolicy">מדיניות פרטיות</span>
          </div>
        </div>

        <!-- MFA Step inside the same dialog -->
        <div v-else class="space-y-5">
          <template v-if="mfaStage === 'choose'">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div v-for="m in reversedActiveMfaMethods" :key="m.ID"
                 class="rounded-xl border p-4 shadow-sm transition-colors border-gray-200 hover:border-gray-300">
              <div class="flex items-center justify-between mb-1">
                <div class="font-semibold text-gray-800">{{ mfaNikeLabel(m) }} <br>  <div v-if="m.NOTE" class="text-xs text-gray-500 mb-3">{{ m.NOTE }}</div>
              </div>
                <div class="flex items-center gap-2">
                  <span class="text-[11px] px-2 py-0.5 rounded text-green-700 bg-green-100">{{ m.TYPE == 'PHONE' ? 'טלפון' : m.TYPE == 'EMAIL' ? 'דוא"ל' : m.TYPE }} פעיל</span>
                </div>
              </div>

              <div class="text-gray-700 text-sm mb-3" style="direction: ltr; text-align: center;">{{ m.VALUE }}</div>

              <div class="flex items-center gap-2 text-xs text-gray-500 mb-3">
                <span v-if="m.LAST_USED" class="px-2 py-0.5 rounded bg-gray-100 text-gray-700">
                  שומש לאחרונה: 
                  {{
                    (() => {
                      // Expect m.LAST_USED format to be "YYYY-MM-DD HH:mm:ss"
                      if (!m.LAST_USED) return '';
                      const [datePart, timePart] = m.LAST_USED.split(' ');
                      if (!datePart || !timePart) return m.LAST_USED;
                      const [y, mon, d] = datePart.split('-');
                      const [h, min] = timePart.split(':');
                      return `${d}/${mon}/${y} ${h}:${min}`;
                    })()
                  }}
                </span>
                <span v-if="m.EXPIRED_DATE" class="px-2 py-0.5 rounded bg-red-100 text-red-700">
                  פג: 
                  {{
                    (() => {
                      // Expect m.EXPIRED_DATE format to be "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD" at least
                      const dateStr = (m.EXPIRED_DATE || '').split(' ')[0];
                      if (!dateStr) return '';
                      const [y, m2, d] = dateStr.split('-');
                      return `${d}/${m2}/${y}`;
                    })()
                  }}
                </span>
              </div>
            
              <div class="flex flex-wrap gap-2">
                <button v-for="t in (m.SEND_TYPE || [])" :key="t" @click.stop="sendMfaCode(m.ID, t)" :disabled="mfaCooldownSeconds > 0 || mfaSending"
                        :class="[
                          'px-3 py-1.5 rounded-lg text-sm text-white',
                          t === 'SMS' ? 'bg-indigo-600 hover:bg-indigo-500' :
                          t === 'CALL' ? 'bg-blue-600 hover:bg-blue-500' :
                          'bg-emerald-600 hover:bg-emerald-500'
                        ]">
                  <span v-if="mfaSending" class="inline-flex items-center">
                    <svg class="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                    </svg>
                    שולח...
                  </span>
                  <span v-else>
                    <template v-if="mfaCooldownSeconds > 0">המתינו {{ mfaCooldownSeconds }}s</template>
                    <template v-else>
                      <span v-if="t === 'SMS'">שליחת קוד בהודעת סמס</span>
                      <span v-else-if="t === 'CALL'">שליחת קוד בשיחה</span>
                      <span v-else-if="t === 'EMAIL'">שליחת קוד למייל</span>
                      <span v-else>{{ t }}</span>
                    </template>
                  </span>
                </button>
              </div>
            </div>
         
          </div>
          <div class="flex items-center gap-2">
              <input id="remember2" type="checkbox" v-model="rememberMe" />
              <label for="remember2" class="text-sm text-gray-700">שמירת החיבור ל-30 יום (זכור אותי)</label>
            </div>
          </template>
          <template v-else>
          <div class="space-y-3">
              <div v-if="mfaError" class="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
                {{ mfaError }}
              </div>
              <div v-if="mfaValidateDetails" class="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-sm">
                <div><strong>סטטוס:</strong> {{ mfaValidateDetails.status }}</div>
                <div v-if="mfaValidateDetails.trys !== undefined"><strong>ניסיונות שבוצעו:</strong> {{ mfaValidateDetails.trys }}</div>
                <div v-if="mfaValidateDetails.left !== undefined"><strong>ניסיונות שנותרו:</strong> {{ mfaValidateDetails.left }}</div>
                <div v-if="mfaValidateDetails.message"><strong>הסבר:</strong> {{ mfaValidateDetails.message }}</div>
              </div>
              <div class="text-sm text-gray-600">
              נשלח קוד ל־
              <span class="font-semibold">{{ mfaSentTo.label }}</span>
              <span class="px-2">•</span>
                <span class="font-mono" style="direction: ltr; unicode-bidi: plaintext;">{{ mfaSentTo.destination }}</span>
              <span class="px-2">•</span>
              <span class="uppercase">{{ mfaSentTo.sendType }}</span>
            </div>
            <label class="block text-sm text-gray-700">הזינו את הקוד</label>
            <input v-model="mfaCode" type="text" class="w-full border rounded-lg px-3 py-2" @keydown.enter="validateMfaCode" />
            <div class="flex items-center gap-2">
              <input id="remember2" type="checkbox" v-model="rememberMe" />
              <label for="remember2" class="text-sm text-gray-700">שמירת החיבור ל-30 יום (זכור אותי)</label>
            </div>
            <div class="flex gap-2">
              <button :disabled="mfaLoading || !mfaCode" @click="validateMfaCode" class="flex-1 transition-all px-4 py-3 text-white bg-green-500 hover:bg-green-600 rounded-lg shadow-sm font-medium">אימות והמשך</button>
              <button :disabled="mfaLoading" @click="sendMfaCode(mfaSentTo.methodId, mfaSentTo.sendType)" class="px-4 py-3 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg shadow-sm font-medium">שליחה מחדש</button>
              <button :disabled="mfaLoading" @click="mfaStage = 'choose'; mfaCode = ''" class="px-4 py-3 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg shadow-sm font-medium">בחירת שיטה אחרת</button>
            </div>
          </div>
          <!-- שמירת תיאור (מוסתר) -->
          <div class="hidden"><input v-model="rememberNote" type="text" class="w-full border rounded-lg px-3 py-2" /></div>
          </template>
        </div>
      </div>
    </div>
  </transition>

  <!-- MFA Dialog -->
  <transition name="fade">
    <div v-if="mfaDialogVisible"
      class="fixed inset-0 bg-gray-900 bg-opacity-50 flex justify-center items-center z-50 p-4"
      style="backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);">

      <div class="bg-white p-8 rounded-xl shadow-xl w-full max-w-md" @click.stop>
        <div class="flex flex-col items-center mb-6">
          <div class="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-indigo-600" fill="none" viewBox="0 0 24 24"
              stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M12 11c0-1.657-1.343-3-3-3S6 9.343 6 11v1H5a2 2 0 00-2 2v3h10v-3a2 2 0 00-2-2h-1v-1z" />
            </svg>
          </div>
          <h3 class="text-2xl font-bold text-gray-800">אימות דו שלבי</h3>
          <p class="text-gray-500 mt-1 text-center">בחרו שיטת אימות, שלחו קוד ואשרו</p>
        </div>

        <div v-if="mfaError" class="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {{ mfaError }}
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-sm text-gray-700 mb-1">שיטת אימות</label>
            <select v-model="selectedMfaId" class="w-full border rounded-lg px-3 py-2">
              <option v-for="m in mfaMethods" :key="m.ID" :value="m.ID">
                {{ m.NIKE || 'שיטה' }} - {{ m.STATUS }}
              </option>
            </select>
          </div>

          <div>
            <label class="block text-sm text-gray-700 mb-1">אופן שליחה</label>
            <select v-model="selectedSendType" class="w-full border rounded-lg px-3 py-2">
              <option v-for="t in (mfaMethods.find(x => x.ID === selectedMfaId)?.SEND_TYPE || [])" :key="t" :value="t">
                {{ t }}
              </option>
            </select>
          </div>

          <div class="flex gap-2">
            <button :disabled="mfaLoading || !selectedMfaId || !selectedSendType" @click="sendMfaCode" :class="[
              mfaLoading ? 'bg-opacity-70 cursor-not-allowed' : 'hover:bg-indigo-500',
              'transition-all w-full px-4 py-3 text-white bg-indigo-600 rounded-lg shadow-sm font-medium'
            ]">
              שליחת קוד
            </button>
          </div>

          <div>
            <label class="block text-sm text-gray-700 mb-1">הזינו את הקוד</label>
            <input v-model="mfaCode" type="text" class="w-full border rounded-lg px-3 py-2" @keydown.enter="validateMfaCode" />
          </div>

          <div class="flex items-center gap-2">
            <input id="remember" type="checkbox" v-model="rememberMe" />
            <label for="remember" class="text-sm text-gray-700">שמירת החיבור ל-30 יום (זכור אותי)</label>
          </div>

          <div>
            <input v-model="rememberNote" type="text" class="w-full border rounded-lg px-3 py-2" placeholder="תיאור לזיהוי (אופציונלי)" />
          </div>

          <button :disabled="mfaLoading || !mfaCode" @click="validateMfaCode" :class="[
            mfaLoading ? 'bg-opacity-70 cursor-not-allowed' : 'hover:bg-green-600',
            'transition-all w-full px-4 py-3 text-white bg-green-500 rounded-lg shadow-sm font-medium'
          ]">
            אימות והמשך
          </button>
        </div>
      </div>
    </div>
  </transition>

  <PrivacyPolicy />
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700&display=swap');

html,
body {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: 'Heebo', system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  direction: rtl;
  font-size: 16px;
  /* הגדלת גודל הפונט הכללי ב-1px */
}

#app {
  height: 100%;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>