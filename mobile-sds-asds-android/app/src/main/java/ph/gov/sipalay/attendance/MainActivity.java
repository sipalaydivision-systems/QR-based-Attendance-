package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startActivity(new Intent(this, SessionStore.isLoggedIn(this) ? DashboardActivity.class : LoginActivity.class));
        finish();
    }
}
