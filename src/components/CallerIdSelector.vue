<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { XMarkIcon, MagnifyingGlassIcon, PlusIcon, InformationCircleIcon, ClockIcon } from '@heroicons/vue/24/outline';
import AddCallerIdModal from './AddCallerIdModal.vue';

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  selectedCallerId: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['close', 'select']);

const showAddModal = ref(false);

const callerIds = ref([]);
const searchQuery = ref('');
const loading = ref(false);
const customerData = ref(null);

const filteredCallerIds = computed(() => {
  let filtered = callerIds.value;
  
  // סנן לפי חיפוש
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    filtered = filtered.filter(callerId => 
      callerId.id.toLowerCase().includes(query) ||
      callerId.label.toLowerCase().includes(query)
    );
  }
  
  return filtered;
});

// פונקציה לקבלת פרטי לקוח
const loadCustomerData = async () => {
  try {
    const { getStoredToken } = await import('../services/api.service');
    const token = getStoredToken();
    const response = await fetch(
      `https://www.call2all.co.il/ym/api/GetCustomerData?token=${encodeURIComponent(token)}`
    );
    const data = await response.json();
    
    if (data.responseStatus === 'OK') {
      customerData.value = data;
    }
  } catch (error) {
    console.error('Error loading customer data:', error);
  }
};

// פונקציה לחישוב ימים עד פג תוקף
const getDaysUntilExpiry = (expiryDate) => {
  if (!expiryDate) return null;
  
  const expiry = new Date(expiryDate);
  const now = new Date();
  const diffTime = expiry - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  return diffDays;
};

// פונקציה לפורמט תאריך
const formatDate = (dateString) => {
  if (!dateString) return '';
  
  const date = new Date(dateString);
  return date.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

// פונקציה לקבלת פרטי מספר משני
const getSecondaryDidDetails = (did) => {
  if (!customerData.value?.secondary_dids) return null;
  
  const secondaryDid = customerData.value.secondary_dids.find(
    item => item.did === did || item.did === `+972${did.substring(1)}` || item.did === `972${did.substring(1)}`
  );
  
  return secondaryDid;
};

// פונקציה לקבלת פרטי מספר מאושר
const getCallerIdDetails = (callerId) => {
  if (!customerData.value?.callerIds) return null;
  
  const callerIdData = customerData.value.callerIds.find(
    item => item.callerId === callerId || item.callerId === `+972${callerId.substring(1)}` || item.callerId === `972${callerId.substring(1)}`
  );
  
  return callerIdData;
};

const loadCallerIds = async () => {
  loading.value = true;
  try {
    // טען את פרטי הלקוח
    await loadCustomerData();
    const { getStoredToken } = await import('../services/api.service');
    const token = getStoredToken();
    const response = await fetch(
      `https://www.call2all.co.il/ym/api/GetApprovedCallerIDs?token=${encodeURIComponent(token)}`
    );
    const data = await response.json();
    
    if (data.responseStatus === 'OK') {
      const allCallerIds = [];
      
      // פונקציה לניקוי פורמט המספר
      const formatNumber = (number) => {
        if (!number) return '';
        // הסר +972 והחלף ב-0
        let formatted = number.replace(/^\+972/, '0');
        // הסר 972 והחלף ב-0
        formatted = formatted.replace(/^972/, '0');
        return formatted;
      };
      
      // הוסף מספר ראשי
      if (data.call?.mainDid) {
        allCallerIds.push({
          id: formatNumber(data.call.mainDid),
          type: 'main',
          label: formatNumber(data.call.mainDid),
          typeLabel: 'מספר ראשי'
        });
      }
      
      // הוסף מספרים משניים
      if (data.call?.secondaryDids) {
        data.call.secondaryDids.forEach(did => {
          const formattedDid = formatNumber(did);
          const secondaryDetails = getSecondaryDidDetails(formattedDid);
          
          allCallerIds.push({
            id: formattedDid,
            type: 'secondary',
            label: formattedDid,
            typeLabel: 'מספר משני',
            usage: secondaryDetails?.usage || null
          });
        });
      }
      
      // הוסף זיהויים מאושרים
      if (data.call?.callerIds) {
        data.call.callerIds.forEach(callerId => {
          const formattedCallerId = formatNumber(callerId);
          const callerIdDetails = getCallerIdDetails(formattedCallerId);
          
          allCallerIds.push({
            id: formattedCallerId,
            type: 'approved',
            label: formattedCallerId,
            typeLabel: 'זיהוי מאושר',
            expiryDate: callerIdDetails?.expiryDate || null
          });
        });
      }
      
      callerIds.value = allCallerIds;
    }
  } catch (error) {
    console.error('Error loading caller IDs:', error);
  } finally {
    loading.value = false;
  }
};

const selectCallerId = (callerId) => {
  emit('select', callerId);
  emit('close');
};

const closeModal = () => {
  searchQuery.value = '';
  emit('close');
};

const openAddModal = () => {
  showAddModal.value = true;
};

const closeAddModal = () => {
  showAddModal.value = false;
};

const handleAddSuccess = () => {
  // רענן את רשימת הזיהויים
  loadCallerIds();
};

onMounted(() => {
  if (props.visible) {
    loadCallerIds();
  }
});

// Watch for visibility changes
watch(() => props.visible, (newVal) => {
  if (newVal) {
    loadCallerIds();
  }
});
</script>

<template>
  <transition name="fade">
    <div v-if="visible" 
      class="fixed inset-0 bg-gray-900 bg-opacity-50 flex justify-center items-center z-50 p-2 sm:p-4"
      style="backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);"
      @click="closeModal">
      
      <div class="bg-white rounded-xl shadow-xl w-full max-w-[98%] sm:max-w-md max-h-[85vh] overflow-hidden mx-1" @click.stop>
        <!-- Header -->
        <div class="flex justify-between items-center p-4 sm:p-6 border-b border-gray-200" dir="rtl">
          <h3 class="text-lg sm:text-xl font-bold text-gray-800">בחר זיהוי יוצא</h3>
          <div class="flex items-center gap-2">
            <button @click="openAddModal" class="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-600 transition">
              <PlusIcon class="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
            <button @click="closeModal" class="p-1.5 rounded-full hover:bg-gray-100 text-gray-500 transition">
              <XMarkIcon class="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </div>
        </div>
        
        <!-- Search -->
        <div class="p-3 sm:p-4 border-b border-gray-200">
          <div class="relative">
            <MagnifyingGlassIcon class="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
              v-model="searchQuery"
              type="text" 
              placeholder="חפש זיהוי יוצא..."
              class="w-full py-2.5 pr-10 pl-4 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              dir="rtl"
            />
          </div>
        </div>
        
        <!-- Caller IDs List -->
        <div class="max-h-64 sm:max-h-96 overflow-y-auto">
          <div v-if="loading" class="p-6 sm:p-8 text-center">
            <div class="animate-spin h-6 w-6 sm:h-8 sm:w-8 border-4 border-indigo-500 border-t-transparent rounded-full mx-auto mb-3 sm:mb-4"></div>
            <p class="text-gray-500 text-sm sm:text-base">טוען זיהויים...</p>
          </div>
          
          <div v-else-if="filteredCallerIds.length === 0" class="p-6 sm:p-8 text-center text-gray-500">
            <p v-if="searchQuery" class="text-sm sm:text-base">לא נמצאו זיהויים מתאימים</p>
            <p v-else class="text-sm sm:text-base">אין זיהויים זמינים</p>
          </div>
          
          <div v-else>
            <div 
              v-for="callerId in filteredCallerIds" 
              :key="callerId.id"
              @click="selectCallerId(callerId.id)"
              :class="[
                'p-4 sm:p-4 hover:bg-gray-50 cursor-pointer transition-colors border-b border-gray-100 last:border-b-0',
                callerId.id === selectedCallerId ? 'bg-indigo-50 hover:bg-indigo-50' : ''
              ]"
            >
              <div class="flex items-center justify-between gap-3" dir="rtl">
                <div class="flex-1 min-w-0 text-right">
                  <p class="font-bold text-gray-900 text-base sm:text-lg break-all">{{ callerId.label }}</p>
                  <p class="text-xs sm:text-sm text-gray-500 break-all">{{ callerId.typeLabel }}</p>
                  
                  <!-- פרטי מספר משני -->
                  <div v-if="callerId.type === 'secondary' && callerId.usage" class="mt-1 flex items-center gap-1">
                    <InformationCircleIcon class="w-3 h-3 text-blue-600" />
                    <p class="text-xs text-blue-600 font-medium">שימוש: {{ callerId.usage }}</p>
                  </div>
                  
                  <!-- פרטי מספר מאושר -->
                  <div v-if="callerId.type === 'approved' && callerId.expiryDate" class="mt-1">
                    <div class="flex items-center gap-1">
                      <ClockIcon class="w-3 h-3 text-orange-600" />
                      <p class="text-xs text-orange-600 font-medium">
                        יפוג ב-{{ formatDate(callerId.expiryDate) }}
                      </p>
                    </div>
                    <p v-if="getDaysUntilExpiry(callerId.expiryDate) !== null" 
                       :class="[
                         'text-xs font-medium mt-0.5',
                         getDaysUntilExpiry(callerId.expiryDate) <= 7 ? 'text-red-600' : 
                         getDaysUntilExpiry(callerId.expiryDate) <= 30 ? 'text-orange-600' : 'text-green-600'
                       ]">
                      בעוד {{ getDaysUntilExpiry(callerId.expiryDate) }} ימים
                    </p>
                  </div>
                </div>
                <div v-if="callerId.id === selectedCallerId" class="text-indigo-600 flex-shrink-0">
                  <svg class="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </transition>

  <!-- Add Caller ID Modal -->
  <AddCallerIdModal 
    :visible="showAddModal"
    @close="closeAddModal"
    @success="handleAddSuccess"
  />
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>