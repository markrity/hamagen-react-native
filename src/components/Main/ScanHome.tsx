import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, AppState, AppStateStatus, BackHandler, Text, DeviceEventEmitter } from 'react-native';
import { connect } from 'react-redux';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { RESULTS, check, request, PERMISSIONS } from 'react-native-permissions';
import { bindActionCreators } from 'redux';
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import SplashScreen from 'react-native-splash-screen';
import { useFocusEffect } from '@react-navigation/native';
// @ts-ignore
import RNSettings from 'react-native-settings';
import moment from 'moment';
import ScanHomeHeader from './ScanHomeHeader';
import NoData from './NoData';
import ExposuresDetected from './ExposuresDetected';
import NoExposures from './NoExposures';
import ExposureInstructions from './ExposureInstructions';
import { toggleWebview } from '../../actions/GeneralActions';
import {
  dismissExposure,
  removeValidExposure,
  setValidExposure,
  updatePointsFromFile
} from '../../actions/ExposuresActions';
import { checkPermissions } from '../../services/LocationService';
import { Exposure } from '../../types';
import { logEvent } from '../../services/AnalyticsService';
import { TouchableOpacity } from '../common';
import { checkSickPeopleFromFile } from '../../services/Tracker';
import { UserLocationsDatabase } from '../../database/Database';

interface Props {
  navigation: any,
  isRTL: boolean,
  strings: any,
  locale: 'he'|'en'|'ar'|'am'|'ru',
  exposures: Exposure[],
  validExposure: Exposure,
  firstPoint?: undefined,
  setValidExposure(exposure: Exposure): void,
  removeValidExposure(): void,
  dismissExposure(exposureId: number): void,
  toggleWebview(isShow: boolean, usageType: string): void,
  updatePointsFromFile(points: Exposure[]): void
}

const SICK_FILE_TYPE = 1;
const LOCATIONS_FILE_TYPE = 2;


const ScanHome = ({ navigation, isRTL, strings, locale, exposures, validExposure, setValidExposure, removeValidExposure, dismissExposure, toggleWebview, firstPoint, updatePointsFromFile }: Props) => {
  const appStateStatus = useRef<AppStateStatus>('active');
  const [{ hasLocation, hasNetwork, hasGPS }, setIsConnected] = useState({ hasLocation: true, hasNetwork: true, hasGPS: true });
  const [testName, setTestName] = useState('');

  useEffect(() => {
    logEvent('Test', { time: moment().valueOf() });

    setTimeout(SplashScreen.hide, 3000);

    checkConnectionStatusOnLoad();

    AppState.addEventListener('change', onAppStateChange);
    NetInfo.addEventListener((state: NetInfoState) => {
      setIsConnected({ hasLocation, hasNetwork: state.isConnected, hasGPS });
    });

    DeviceEventEmitter.addListener(RNSettings.GPS_PROVIDER_EVENT, handleGPSProviderEvent);

    return () => {
      AppState.removeEventListener('change', onAppStateChange);
      DeviceEventEmitter.removeListener(RNSettings.GPS_PROVIDER_EVENT, handleGPSProviderEvent);
    };
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      const onBackPress = () => {
        BackHandler.exitApp();
        return true;
      };

      BackHandler.addEventListener('hardwareBackPress', onBackPress);

      return () => {
        BackHandler.removeEventListener('hardwareBackPress', onBackPress);
      };
    }, [])
  );

  const checkConnectionStatusOnLoad = async () => {
    const locationPermission = await checkPermissions();
    const networkStatus = await NetInfo.fetch();
    const GPSStatus = await RNSettings.getSetting(RNSettings.LOCATION_SETTING);

    setIsConnected({ hasLocation: locationPermission === RESULTS.GRANTED, hasNetwork: networkStatus.isConnected, hasGPS: GPSStatus === RNSettings.ENABLED });
  };

  const onAppStateChange = async (state: AppStateStatus) => {
    if (state === 'active' && appStateStatus.current !== 'active') {
      const locationPermission = await checkPermissions();
      const GPSStatus = await RNSettings.getSetting(RNSettings.LOCATION_SETTING);

      setIsConnected({ hasLocation: locationPermission === RESULTS.GRANTED, hasNetwork, hasGPS: GPSStatus === RNSettings.ENABLED });
    }

    appStateStatus.current = state;
  };

  const handleGPSProviderEvent = (e: any) => {
    setIsConnected({ hasLocation, hasNetwork, hasGPS: e[RNSettings.LOCATION_SETTING] === RNSettings.ENABLED });
  };

  const renderRelevantState = () => {
    if (validExposure) {
      return (
        <ExposureInstructions isRTL={isRTL} strings={strings} locale={locale} exposure={validExposure} removeValidExposure={removeValidExposure} />
      );
    } if (!hasLocation || !hasNetwork) {
      return (
        <NoData strings={strings} />
      );
    } if (exposures.length > 0) {
      return (
        <ExposuresDetected
          isRTL={isRTL}
          strings={strings}
          exposures={exposures}
          onValidExposure={exposure => setValidExposure(exposure)}
          dismissExposure={exposureId => dismissExposure(exposureId)}
        />
      );
    }

    return <NoExposures strings={strings} toggleWebview={toggleWebview} firstPoint={firstPoint} />;
  };

  const chooseFile = async (fileType: number) => {
    try {
      const res = await DocumentPicker.pick({
        type: [DocumentPicker.types.plainText]
      });
      console.log(
        res.uri,
        res.type, // mime type
        res.name,
        res.size
      );
      const fileUri = res.uri;
      const rawText = await RNFS.readFile(fileUri);
      if (fileType === SICK_FILE_TYPE) {
        const pointsJSON = JSON.parse(rawText.trim());
        setTestName(pointsJSON?.testName ?? '');
        updatePointsFromFile(pointsJSON);
        await checkSickPeopleFromFile();
      } else {
        const db = new UserLocationsDatabase();

        // location file
        const pointsArr: string[] = rawText.split('\n');

        let isFirst = true;

        for (const item of pointsArr) {
          if (!isFirst) { // to ignore the first row which holds the titles...
            const sampleArr = item.split(',');

            for (let i = 0; i < sampleArr.length; i++) {
              await db.addSample({
                lat: parseFloat(sampleArr[0]),
                long: parseFloat(sampleArr[1]),
                accuracy: parseFloat(sampleArr[2]),
                startTime: parseFloat(sampleArr[3]),
                endTime: parseFloat(sampleArr[4]),
                geoHash: '',
                wifiHash: ''
              });
            }
          }

          isFirst = false;
        }
      }
    } catch (error) {
      if (DocumentPicker.isCancel(error)) {
        // User cancelled the picker, exit any dialogs or menus and move on
      } else {
        throw error;
      }
    }
  };

  const fetchPointsFromFile = async (fileType: number) => {
    try {
      const isStoragePermissionGranted = await check(PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE);
      if (isStoragePermissionGranted === RESULTS.GRANTED) {
        await chooseFile(fileType);
      } else {
        const requestPermissionRes = await request(PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE);
        if (requestPermissionRes === RESULTS.GRANTED) {
          await chooseFile(fileType);
        }
      }
    } catch (err) {
      console.log(err);
    }
  };

  const renderDebugView = () => {
    return (
      <View style={styles.debugContainerStyle}>
        <Text style={{ marginBottom: 10 }}>{`TestName: ${testName}`}</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignSelf: 'stretch' }}>
          <TouchableOpacity style={styles.debugButtonStyle} onPress={() => { fetchPointsFromFile(SICK_FILE_TYPE); }}>
            <Text>Load Sick</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.debugButtonStyle} onPress={() => { fetchPointsFromFile(LOCATIONS_FILE_TYPE); }}>
            <Text>Load Locations</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <ScanHomeHeader
        isRTL={isRTL}
        strings={strings}
        isConnected={hasLocation && hasNetwork}
        showChangeLanguage
        goToExposureHistory={() => navigation.navigate('ExposuresHistory')}
      />
      {renderDebugView()}
      {renderRelevantState()}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff'
  },
  debugContainerStyle: {
    marginTop: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  debugButtonStyle: {
    borderWidth: 1,
    paddingHorizontal: 3
  }
});

const mapStateToProps = (state: any) => {
  const {
    locale: { isRTL, strings, locale },
    exposures: { exposures, validExposure, firstPoint }
  } = state;

  return { isRTL, strings, locale, exposures, validExposure, firstPoint };
};


const mapDispatchToProps = (dispatch: any) => {
  return bindActionCreators({
    setValidExposure,
    removeValidExposure,
    dismissExposure,
    toggleWebview,
    updatePointsFromFile
  }, dispatch);
};

export default connect(mapStateToProps, mapDispatchToProps)(ScanHome);