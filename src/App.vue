<script setup>
import { ref, watchEffect, nextTick } from 'vue';
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
        const readedMessagesFetch = await fetch(
          `https://www.call2all.co.il/ym/api/GetTextFile?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&what=ivr2:YemotSMSInboxReadedMessages.ini`
        );

        const readedMessagesRes = await readedMessagesFetch.json();
        let readedMessages = [];

        if (readedMessagesRes.message === "file does not exist") {
          await fetch(
            `https://www.call2all.co.il/ym/api/UploadTextFile?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&what=ivr2:YemotSMSInboxReadedMessages.ini&contents=${JSON.stringify(readedArray)}`
          );
        } else {
          const readedMessagesData = readedMessagesRes.contents;
          const readedMessagesObj = JSON.parse(readedMessagesData);

          readedMessages = readedMessagesObj;
          readedMessages = readedMessages.concat(readedArray);

          await fetch(`https://www.call2all.co.il/ym/api/UploadTextFile`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              token: `${localStorage.getItem('username')}:${localStorage.getItem('password')}`,
              what: 'ivr2:YemotSMSInboxReadedMessages.ini',
              contents: JSON.stringify(readedMessages)
            })
          });

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
  if (!localStorage.getItem('username') || !localStorage.getItem('password')) {
    loginDialogVisible.value = true;
    usernameFocus.value = true;
  } else {
    document.title = 'מערכת סמסים - ' + localStorage.getItem('username');

    try {
      console.log('Checking Google auth status during initialization...');
      const status = await checkGoogleAuthStatus();
      googleAuthStatus.value = status;
      console.log('Initial Google auth status:', status);

      window.dispatchEvent(new CustomEvent('googleAuthStatusUpdated'));
    } catch (error) {
      console.error('Error checking Google auth status during init:', error);
    }

    await getMessages();

    // הגדרת ערכים ראשוניים ל-localStorage אם לא קיימים
    if (!localStorage.getItem('lastIncomingMessage')) {
      localStorage.setItem('lastIncomingMessage', '');
    }
    if (!localStorage.getItem('lastOutgoingMessage')) {
      localStorage.setItem('lastOutgoingMessage', '');
    }

    setInterval(checkNewMessages, 5000);
  }
}

async function checkNewMessages() {
  try {
    const username = localStorage.getItem('username');
    const password = localStorage.getItem('password');

    // בדיקת הודעות נכנסות חדשות
    const incomingResponse = await fetch(
      `https://www.call2all.co.il/ym/api/GetIncomingSms?token=${username}:${password}&limit=1`
    );

    const incomingData = await incomingResponse.json();
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
    const outgoingResponse = await fetch(
      `https://www.call2all.co.il/ym/api/GetSmsOutLog?token=${username}:${password}&limit=1`
    );

    const outgoingData = await outgoingResponse.json();
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
    console.log('Getting messages and refreshing data...');

    const incoming = await fetch(
      `https://www.call2all.co.il/ym/api/GetIncomingSms?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&limit=3000`
    );

    const outgoing = await fetch(
      `https://www.call2all.co.il/ym/api/GetSmsOutLog?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&limit=999999`
    );

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

    const readedMessagesFetch = await fetch(
      `https://www.call2all.co.il/ym/api/GetTextFile?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&what=ivr2:YemotSMSInboxReadedMessages.ini`
    );

    const readedMessagesRes = await readedMessagesFetch.json();
    let readedMessages = [];

    if (readedMessagesRes.message === "file does not exist") {
      await fetch(
        `https://www.call2all.co.il/ym/api/UploadTextFile?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&what=ivr2:YemotSMSInboxReadedMessages.ini&contents=${JSON.stringify([])}`
      );
    } else {
      const readedMessagesData = readedMessagesRes.contents;
      const readedMessagesObj = JSON.parse(readedMessagesData);
      readedMessages = readedMessagesObj;
    }

    const incomingMsgs = (await incoming.json()).rows || [];
    const outgoingMsgs = (await outgoing.json()).rows || [];

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
    const response = await fetch(`https://www.call2all.co.il/ym/api/GetSession?token=${username.value}:${password.value}`);
    const data = await response.json();

    if (data.responseStatus === 'OK') {
      // שמור פרטי התחברות
      localStorage.setItem('username', username.value);
      localStorage.setItem('password', password.value);
      loginDialogVisible.value = false;

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

      // קבל הודעות וחוזר לשגרה
      await getMessages();
      
      // הגדרת ערכים ראשוניים ל-localStorage אם לא קיימים
      if (!localStorage.getItem('lastIncomingMessage')) {
        localStorage.setItem('lastIncomingMessage', '');
      }
      if (!localStorage.getItem('lastOutgoingMessage')) {
        localStorage.setItem('lastOutgoingMessage', '');
      }
      
      setInterval(checkNewMessages, 5000);

    } else {
      error.value = 'שגיאה בהתחברות: ' + data.message;
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
    const readedMessagesFetch = await fetch(
      `https://www.call2all.co.il/ym/api/GetTextFile?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&what=ivr2:YemotSMSInboxReadedMessages.ini`
    );

    const readedMessagesRes = await readedMessagesFetch.json();
    let readedMessages = [];

    if (readedMessagesRes.message === "file does not exist") {
      // אם הקובץ לא קיים, צור אותו עם כל ההודעות הלא נקראות
      await fetch(
        `https://www.call2all.co.il/ym/api/UploadTextFile?token=${localStorage.getItem('username')}:${localStorage.getItem('password')}&what=ivr2:YemotSMSInboxReadedMessages.ini&contents=${JSON.stringify(allUnreadMessages)}`
      );
    } else {
      // אם הקובץ קיים, הוסף את ההודעות החדשות
      const readedMessagesData = readedMessagesRes.contents;
      readedMessages = JSON.parse(readedMessagesData);
      readedMessages = readedMessages.concat(allUnreadMessages);

      // עדכן את הקובץ עם כל ההודעות הנקראות
      await fetch(`https://www.call2all.co.il/ym/api/UploadTextFile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token: `${localStorage.getItem('username')}:${localStorage.getItem('password')}`,
          what: 'ivr2:YemotSMSInboxReadedMessages.ini',
          contents: JSON.stringify(readedMessages)
        })
      });
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

      <div class="bg-white p-8 rounded-xl shadow-xl w-full max-w-md" @click.stop>
        <div class="flex flex-col items-center mb-6">
          <div class="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-indigo-600" fill="none" viewBox="0 0 24 24"
              stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <h3 class="text-2xl font-bold text-gray-800">התחברות למערכת</h3>
          <p class="text-gray-500 mt-1 text-center">הזן את פרטי ההתחברות שלך כדי להתחיל</p>
        </div>

        <div v-if="error" class="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {{ error }}
        </div>

        <div class="space-y-4">
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