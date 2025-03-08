import { 
  BarChart3,
  TrendingUp, 
  ChartPie, 
  CreditCard, 
  UserCircle
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
      className="flex flex-col items-center justify-center w-1/5 relative py-2 transition-all"
      onClick={onClick}
    >
      {active && (
        <div className="absolute top-0 left-1/2 w-8 h-1 bg-red-600 rounded-b-lg transform -translate-x-1/2 transition-all duration-300" />
      )}
      <div className={`mb-1 transition-colors duration-200 ${active ? 'text-red-600 scale-110' : 'text-white/50'}`}>
        {icon}
      </div>
      <span className={`text-xs md:text-sm transition-colors duration-200 ${active ? 'text-white font-medium' : 'text-white/50'}`}>
        {label}
      </span>
      {active && (
        <div className="absolute -bottom-1 left-1/2 w-1.5 h-1.5 bg-red-600 rounded-full transform -translate-x-1/2" />
      )}
    </button>
  );
};

interface BottomNavigationProps {
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  onAccountClick?: () => void;
}

const BottomNavigation = ({ activeTab = "overview", onTabChange, onAccountClick }: BottomNavigationProps) => {
  const [animateNav, setAnimateNav] = useState(false);

  useEffect(() => {
    // Animate the nav when it first mounts
    setAnimateNav(true);
  }, []);

  const handleTabChange = (tab: string) => {
    if (tab === "account" && onAccountClick) {
      onAccountClick();
      return;
    }
    
    if (onTabChange) {
      onTabChange(tab);
    }
  };

  return (
    <div 
      className={`fixed bottom-0 left-0 right-0 h-16 md:h-20 backdrop-blur-sm bg-black/80 border-t border-white/10 flex items-center justify-between px-2 md:px-4 transition-all duration-300 ease-in-out z-50 ${
        animateNav ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'
      }`}
    >
      <div className="w-full max-w-xl mx-auto flex items-center justify-between">
        <NavItem 
          icon={<BarChart3 className="w-5 h-5 md:w-6 md:h-6" />} 
          label="Overview" 
          active={activeTab === "overview"}
          onClick={() => handleTabChange("overview")}
        />
        <NavItem 
          icon={<TrendingUp className="w-5 h-5 md:w-6 md:h-6" />} 
          label="Hourly" 
          active={activeTab === "hourly"}
          onClick={() => handleTabChange("hourly")}
        />
        <NavItem 
          icon={<ChartPie className="w-5 h-5 md:w-6 md:h-6" />} 
          label="Categories" 
          active={activeTab === "categories"}
          onClick={() => handleTabChange("categories")}
        />
        <NavItem 
          icon={<CreditCard className="w-5 h-5 md:w-6 md:h-6" />} 
          label="Gift Cards" 
          active={activeTab === "giftcards"}
          onClick={() => handleTabChange("giftcards")}
        />
        <NavItem 
          icon={<UserCircle className="w-5 h-5 md:w-6 md:h-6" />} 
          label="Account"
          active={activeTab === "account"}
          onClick={() => handleTabChange("account")}
        />
      </div>
    </div>
  );
};

export default BottomNavigation;