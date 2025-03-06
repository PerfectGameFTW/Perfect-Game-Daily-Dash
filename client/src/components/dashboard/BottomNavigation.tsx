import { 
  BarChart3,
  TrendingUp, 
  ChartPie, 
  CreditCard, 
  Settings
} from "lucide-react";
import { useEffect, useState } from "react";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

const NavItem = ({ icon, label, active, onClick }: NavItemProps) => {
  return (
    <button 
      className="flex flex-col items-center justify-center w-1/5 relative py-2"
      onClick={onClick}
    >
      {active && (
        <div className="absolute top-0 left-1/2 w-1/2 h-1 bg-primary rounded-b-lg transform -translate-x-1/2" />
      )}
      <div className={`mb-1 ${active ? 'text-primary' : 'text-white/50'}`}>
        {icon}
      </div>
      <span className={`text-xs ${active ? 'text-white font-medium' : 'text-white/50'}`}>
        {label}
      </span>
    </button>
  );
};

interface BottomNavigationProps {
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}

const BottomNavigation = ({ activeTab = "overview", onTabChange }: BottomNavigationProps) => {
  const [animateNav, setAnimateNav] = useState(false);

  useEffect(() => {
    // Animate the nav when it first mounts
    setAnimateNav(true);
  }, []);

  const handleTabChange = (tab: string) => {
    if (onTabChange) {
      onTabChange(tab);
    }
  };

  return (
    <div 
      className={`fixed bottom-0 left-0 right-0 h-20 backdrop-blur-sm bg-black/70 border-t border-white/10 flex items-center justify-between px-2 transition-all duration-300 ease-in-out ${
        animateNav ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'
      }`}
    >
      <NavItem 
        icon={<BarChart3 className="w-5 h-5" />} 
        label="Overview" 
        active={activeTab === "overview"}
        onClick={() => handleTabChange("overview")}
      />
      <NavItem 
        icon={<TrendingUp className="w-5 h-5" />} 
        label="Hourly" 
        active={activeTab === "hourly"}
        onClick={() => handleTabChange("hourly")}
      />
      <NavItem 
        icon={<ChartPie className="w-5 h-5" />} 
        label="Categories" 
        active={activeTab === "categories"}
        onClick={() => handleTabChange("categories")}
      />
      <NavItem 
        icon={<CreditCard className="w-5 h-5" />} 
        label="Gift Cards" 
        active={activeTab === "giftcards"}
        onClick={() => handleTabChange("giftcards")}
      />
      <NavItem 
        icon={<Settings className="w-5 h-5" />} 
        label="Settings"
        active={activeTab === "settings"}
        onClick={() => handleTabChange("settings")}
      />
    </div>
  );
};

export default BottomNavigation;