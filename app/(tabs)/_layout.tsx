import { Tabs } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';

const INACTIVE = 'rgba(255,255,255,0.65)';

function tabOptions(icon: string, label: string, activeColor: string) {
  return {
    title: label,
    tabBarLabel: label,
    tabBarActiveTintColor: activeColor,
    tabBarInactiveTintColor: INACTIVE,
    tabBarIcon: ({ focused }: { focused: boolean }) => (
      <FontAwesome5 name={icon as any} size={15} color={focused ? activeColor : INACTIVE} solid />
    ),
  };
}

export default function TabLayout() {
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();

  // Without an explicit safe-area inset, the tab bar's lower edge overlaps the
  // iOS home-indicator gesture region — touches near the bottom-left (the Home
  // tab) get eaten by the system. Add the inset to the height AND mirror it as
  // bottom padding so icons sit fully above the indicator.

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.navy,
          borderTopWidth: 0,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarItemStyle: {
          paddingVertical: 6,
        },
        tabBarLabelStyle: {
          fontSize: 9,
          fontWeight: '600',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={tabOptions('home', 'Home', colors.accent)}
      />
      <Tabs.Screen
        name="spik"
        options={tabOptions(SECTIONS.spik.icon, SECTIONS.spik.label, SECTIONS.spik.color)}
      />
      <Tabs.Screen
        name="memories"
        options={tabOptions(SECTIONS.memories.icon, SECTIONS.memories.label, SECTIONS.memories.color)}
      />
      <Tabs.Screen
        name="whats-on"
        options={tabOptions(SECTIONS.events.icon, 'Events', SECTIONS.events.color)}
      />
      <Tabs.Screen
        name="shifts"
        options={tabOptions(SECTIONS.shifts.icon, SECTIONS.shifts.label, SECTIONS.shifts.color)}
      />
      <Tabs.Screen
        name="services"
        options={{ href: null }}
      />
      <Tabs.Screen
        name="local"
        options={tabOptions(SECTIONS.local.icon, SECTIONS.local.label, SECTIONS.local.color)}
      />
      <Tabs.Screen
        name="fetch"
        options={tabOptions(SECTIONS.fetch.icon, SECTIONS.fetch.label, SECTIONS.fetch.color)}
      />
      <Tabs.Screen
        name="me"
        options={{ href: null }}
      />
    </Tabs>
  );
}
