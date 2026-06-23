import { Tabs } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, SIDEBAR_WIDTH } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { AppTabBar } from '@/components/AppTabBar';
import { useAppLayout } from '@/hooks/useAppLayout';

const INACTIVE = 'rgba(255,255,255,0.65)';

function tabOptions(icon: string, label: string, activeColor: string) {
  return {
    title: label,
    tabBarLabel: label,
    tabBarActiveTintColor: activeColor,
    tabBarInactiveTintColor: INACTIVE,
    tabBarIcon: ({ focused, color }: { focused: boolean; color: string }) => (
      <FontAwesome5 name={icon as any} size={15} color={color} solid />
    ),
  };
}

export default function TabLayout() {
  const { profile } = useAuth();
  const { isTablet } = useAppLayout();

  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // On tablets the sidebar is an absolute left rail; offset every
        // scene to the right so content never sits underneath it.
        sceneStyle: { paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 },
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
        name="da-boats"
        options={tabOptions(SECTIONS.daBoats.icon, SECTIONS.daBoats.label, SECTIONS.daBoats.color)}
      />
      <Tabs.Screen
        name="whats-on"
        options={tabOptions(SECTIONS.events.icon, SECTIONS.events.label, SECTIONS.events.color)}
      />
      <Tabs.Screen
        name="jobs"
        options={tabOptions(SECTIONS.jobs.icon, 'Jobs', SECTIONS.jobs.color)}
      />
      <Tabs.Screen
        name="shifts"
        options={tabOptions(SECTIONS.shifts.icon, 'Shifts', SECTIONS.shifts.color)}
      />
      <Tabs.Screen
        name="services"
        options={tabOptions(SECTIONS.services.icon, 'Directory', SECTIONS.services.color)}
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
